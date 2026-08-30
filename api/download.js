import { Readable } from 'stream';
import { connectToDatabase, SystemConfig, ApiSubscription, User } from '../db.js';
import { verifySessionToken } from './auth/me.js';
import { consumeFreeTrial } from './parse.js';

export const config = { maxDuration: 60 };

// In-memory cache to avoid MongoDB call on every chunk request
let cachedToken = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getNdusToken() {
  const now = Date.now();
  if (cachedToken && (now - cacheTime) < CACHE_TTL) {
    return cachedToken;
  }
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    if (config && config.value) {
      cachedToken = config.value;
      cacheTime = now;
      console.log('[NDUS] Retrieved token from MongoDB config cache.');
      return cachedToken;
    }
  } catch (err) {
    console.error('[NDUS Cache] Failed to fetch from DB:', err.message);
  }
  return process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
}

function isPrivateHost(host) {
  const blocked = /(^|\.)(local|localhost|internal|home|corp)$/i;
  if (blocked.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Range');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  // ── PREMIUM GATE: /download is PAID-only ──
  // Master API_KEY (website/free users) must NOT access the NDUS leech proxy.
  // Only verified active ApiSubscription tokens or Google authenticated accounts are permitted.
  const isMasterKey = apiKey && apiKey === process.env.API_KEY;
  let isPremium = false;
  let isTrial = false;
  let userEmail = '';

  if (isMasterKey) {
    console.log('[ROUTER] /download: master_key entitlement=free → PREMIUM_REQUIRED');
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
            console.log(`[ROUTER] /download: user=${userEmail} entitlement=paid(${user.plan})`);
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
              console.log(`[ROUTER] /download: user=${userEmail} entitlement=free_trial trials_remaining=${trials}`);
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
            console.log(`[ROUTER] /download: developer=${sub.email} entitlement=developer`);
          } else {
            return res.status(403).json({ success: false, code: 'PREMIUM_EXPIRED', message: 'Your premium plan has expired.' });
          }
        }
      }
    } catch (dbErr) {
      console.error('[download] Entitlement DB check failed:', dbErr.message);
      return res.status(500).json({ error: 'Internal entitlement validation error.' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorized. Missing API key.' });
  }

  if (!isPremium && !isTrial) {
    return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', message: 'This feature requires an active premium plan.' });
  }

  const { url, filename } = req.query;
  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: "Invalid download URL" });
  }
  if (!/^https?:$/i.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return res.status(400).json({ error: "Invalid download URL" });
  }

  const ndusToken = await getNdusToken();
  // Determine referer from the upstream URL domain
  let referer = 'https://www.terabox.com/';
  try {
    const u = new URL(url);
    const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box'];
    if (tbDomains.some(d => u.hostname.includes(d))) {
      referer = 'https://www.1024terabox.com/';
    }
  } catch {}
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': referer,
  };
  if (ndusToken) headers['Cookie'] = ndusToken.includes('=') ? ndusToken : `ndus=${ndusToken}`;

  const range = req.headers['range'];
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach upstream: ' + e.message });
  }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: `Upstream returned HTTP ${upstream.status}` });
  }

  // Consume free trial atomically on successful upstream response
  if (isTrial) {
    const success = await consumeFreeTrial(userEmail);
    if (!success) {
      console.warn(`[Trial] /download trial consumption failed for ${userEmail} (trials exhausted).`);
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        message: 'You have exhausted your 3 free premium trials. Please buy a plan to continue.'
      });
    }
  }

  const copyHeader = (name, value) => {
    if (value) res.setHeader(name, value);
  };
  copyHeader('Content-Type', upstream.headers.get('content-type'));
  copyHeader('Content-Length', upstream.headers.get('content-length'));
  copyHeader('Content-Range', upstream.headers.get('content-range'));
  copyHeader('Accept-Ranges', upstream.headers.get('accept-ranges'));

  if (filename) {
    const safe = String(filename).replace(/[^\w\-. ]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  }

  res.status(upstream.status);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }
  return res.end();
}
