import { TeraBoxApp } from '../api.js';
import { connectToDatabase, SystemConfig, ApiSubscription, User } from '../db.js';
import { verifySessionToken } from './auth/me.js';
import { consumeFreeTrial } from './parse.js';

async function getNdusToken() {
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    if (config && config.value) return config.value;
  } catch (err) {}
  return process.env.TERABOX_NDUS || '';
}

function buildCookie(ndusToken, browserId) {
  if (ndusToken && ndusToken.includes('=')) return ndusToken;
  let cookie = ndusToken ? `ndus=${ndusToken}` : '';
  if (browserId) cookie += `; browserid=${browserId}`;
  return cookie;
}

const TB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = req.query.apiKey || req.headers['x-api-key'];

  // ── PREMIUM GATE: /dlink is PAID-only ──
  // Master API_KEY (website/free users) must NOT access premium NDUS via /dlink.
  // Only verified active ApiSubscription tokens or Google authenticated accounts are permitted.
  const isMasterKey = apiKey && apiKey === process.env.API_KEY;
  let isPremium = false;
  let isTrial = false;
  let userEmail = '';

  if (isMasterKey) {
    console.log('[ROUTER] /dlink: master_key entitlement=free → PREMIUM_REQUIRED');
    return res.status(403).json({
      success: false,
      code: 'PREMIUM_REQUIRED',
      message: 'This feature requires an active premium plan.'
    });
  } else if (apiKey) {
    try {
      await connectToDatabase();

      // 1. Google Auth session check
      const decoded = verifySessionToken(apiKey);
      if (decoded && decoded.email) {
        userEmail = decoded.email.toLowerCase().trim();
        const user = await User.findOne({ email: userEmail });
        if (user) {
          const isPremiumUser = user.premiumStatus === 'premium' || user.plan === 'premium';
          const isExpired = user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date();

          if (isPremiumUser && !isExpired) {
            isPremium = true;
            console.log(`[ROUTER] /dlink: user=${userEmail} entitlement=paid(${user.plan})`);
          } else if (isPremiumUser && isExpired) {
            user.plan = 'free';
            user.premiumStatus = 'expired';
            await user.save();
            return res.status(403).json({ success: false, code: 'PREMIUM_EXPIRED', message: 'Your premium plan has expired.' });
          } else {
            // Free account - check trial limit
            const trials = user.freePremiumUsesRemaining !== undefined ? user.freePremiumUsesRemaining : 3;
            if (trials > 0) {
              isPremium = true;
              isTrial = true;
              console.log(`[ROUTER] /dlink: user=${userEmail} entitlement=free_trial trials_remaining=${trials}`);
            } else {
              return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', message: 'You have exhausted your 3 free trials. Please upgrade to premium.' });
            }
          }
        }
      }

      // 2. Developer token check (Backward Compatibility)
      if (!isPremium && !isTrial) {
        const sub = await ApiSubscription.findOne({ token: apiKey });
        if (sub && sub.status === 'active') {
          const isExpired = sub.expiresAt && new Date(sub.expiresAt) < new Date();
          if (!isExpired) {
            isPremium = true;
            console.log(`[ROUTER] /dlink: developer=${sub.email} entitlement=developer`);
          } else {
            return res.status(403).json({ success: false, code: 'PREMIUM_EXPIRED', message: 'Your premium plan has expired.' });
          }
        }
      }
    } catch (dbErr) {
      console.error('[dlink] Entitlement DB check failed:', dbErr.message);
      return res.status(500).json({ error: 'Internal entitlement validation error.' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorized. Missing API key.' });
  }

  if (!isPremium && !isTrial) {
    return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', message: 'This feature requires an active premium plan.' });
  }

  const { fs_id, share_id, uk, sign: cachedSign, timestamp: cachedTs } = req.query;
  if (!fs_id || !share_id || !uk) {
    return res.status(400).json({ error: 'Missing required params: fs_id, share_id, uk' });
  }

  try {
    const ndusToken = await getNdusToken();
    if (!ndusToken) return res.status(500).json({ error: 'No NDUS token available' });

    const browserId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const whost = 'https://www.1024terabox.com';

    // Get sign + timestamp via shorturlinfo (we need share_id based approach here)
    // Use /share/download with sign from /api/shorturlinfo won't work without surl
    // Instead, use app.getDownloadLink or direct /share/download call with ndus session
    const app = new TeraBoxApp(ndusToken);
    app.params.ua = TB_UA;
    app.TERABOX_DOMAIN = '1024terabox.com';
    app.params.whost = whost;
    app.params.uhost = 'https://c-all.1024terabox.com';

    // Fetch sign and timestamp - use cache if provided
    let sign = cachedSign || '';
    let timestamp = cachedTs || '';

    if (!sign || !timestamp) {
      try {
        const infoUrl = `${whost}/api/shareinfo?shareid=${share_id}&uk=${uk}`;
        const infoRes = await fetch(infoUrl, {
          signal: AbortSignal.timeout(3000),
          headers: { 'User-Agent': TB_UA, 'Cookie': buildCookie(ndusToken, browserId) }
        });
        const infoContentType = infoRes.headers.get('content-type') || '';
        if (infoContentType.includes('json')) {
          const infoData = await infoRes.json();
          if (infoData && infoData.errno === 0) {
            sign = infoData.sign || '';
            timestamp = infoData.timestamp || '';
          }
        } else {
          console.error('[dlink] shareinfo returned non-JSON response');
        }
      } catch (e) {
        console.error('[dlink] shareinfo error:', e.message);
      }
    }

    if (!sign || !timestamp) {
      return res.status(200).json({ dlink: '', error: 'Could not get sign/timestamp' });
    }

    const dlUrl = new URL(`${whost}/share/download`);
    dlUrl.search = new URLSearchParams({
      app_id: '250528', web: '1', channel: 'dubian-wap', clienttype: '0',
      shareid: String(share_id), uk: String(uk),
      fid_list: JSON.stringify([String(fs_id)]),
      sign, timestamp: String(timestamp),
      product: 'share', nozip: '0', type: 'dlink',
    });

    const dlRes = await fetch(dlUrl, {
      headers: {
        'User-Agent': TB_UA,
        'Cookie': buildCookie(ndusToken, browserId),
        'Referer': `${whost}/`,
      },
      signal: AbortSignal.timeout(5000),
    });
    const dlContentType = dlRes.headers.get('content-type') || '';
    if (!dlContentType.includes('json')) {
      return res.status(200).json({ dlink: '', error: 'TeraBox returned non-JSON (rate limited or blocked)' });
    }
    const dlData = await dlRes.json();
    console.log('[dlink] share/download response:', JSON.stringify(dlData));

    if (dlData && dlData.errno === 0 && dlData.dlink) {
      // Consume trial for trial users on successful dlink resolution
      if (isTrial) {
        const success = await consumeFreeTrial(userEmail);
        if (!success) {
          console.warn(`[Trial] dlink trial consumption failed for ${userEmail} (trials exhausted).`);
          return res.status(403).json({
            success: false,
            code: 'PREMIUM_REQUIRED',
            message: 'You have exhausted your 3 free premium trials. Please buy a plan to continue.'
          });
        }
      }
      return res.status(200).json({ dlink: dlData.dlink, sign, timestamp });
    }

    return res.status(200).json({ dlink: '', error: `errno=${dlData && dlData.errno} errmsg=${dlData && dlData.errmsg}`, sign, timestamp });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
