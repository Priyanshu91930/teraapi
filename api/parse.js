import { TeraBoxApp } from '../api.js';
import ytdl from '@distube/ytdl-core';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';
import { recordPageView, connectToDatabase, ApiSubscription, SystemConfig, LinkCache, User } from '../db.js';
import { verifySessionToken } from './auth/me.js';

function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper: build cookie string from ndus token and optional browserId
function buildCookie(ndusToken, browserId) {
  if (ndusToken && ndusToken.includes('=')) {
    // Already a full cookie string
    return ndusToken;
  }
  // Legacy: just ndus value
  let cookie = ndusToken ? `ndus=${ndusToken}` : '';
  if (browserId) cookie += `; browserid=${browserId}`;
  return cookie;
}

// Function to get the current ndus token (either from MongoDB, or falling back to process.env)
async function getNdusToken() {
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    if (config && config.value) {
      console.log('[NDUS] Retrieved token from MongoDB config cache.');
      return config.value;
    }
  } catch (err) {
    console.error('[NDUS Cache] Failed to fetch from DB:', err.message);
  }
  return process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
}

// ── ANONYMOUS MULTI-DOMAIN SHARE FETCHER ────────────────────────────────────
// Fetches TeraBox share list WITHOUT any login credentials.
// Strategy: Try multiple TeraBox mirror domains. For each, first try the
// /share/list endpoint with jsToken=''; if that returns errno 4000020
// (verification), skip and try next domain. No ndus, no cookies, no login.
// Works because some mirrors allow anonymous listing without jsToken.
async function fetchAnonShareList(shortUrl) {
  const { request, Agent } = await import('undici');
  // Agent-level redirect following (maxRedirections is NOT a request-level option in undici)
  const redirectAgent = new Agent({ maxRedirections: 5 });

  // Prioritised list: start with mirrors that tend to not require login for listing
  const MIRROR_DOMAINS = [
    'https://www.1024terabox.com',
    'https://www.freeterabox.com',
    'https://www.4funbox.com',
    'https://www.mirrobox.com',
    'https://www.nephobox.com',
  ];

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  for (const domain of MIRROR_DOMAINS) {
    // ── Step 1: Try to get jsToken from the share page itself (not /main) ──
    let jsToken = '';
    try {
      const sharePageUrl = `${domain}/s/${shortUrl}`;
      const pageRes = await request(sharePageUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        dispatcher: redirectAgent,
        signal: AbortSignal.timeout(8000),
      });
      if (pageRes.statusCode === 200) {
        const html = await pageRes.body.text();
        // Try to extract jsToken from the share page HTML
        const m1 = html.match(/window\.jsToken%20%3D%20a%7D%3Bfn%28%22([^"]+)%22%29/);
        const m2 = html.match(/jsToken["\s]*[:=]["\s]*['"]([A-Za-z0-9%_-]{10,})['"]/);
        const m3 = html.match(/%28%22([A-Za-z0-9%_\-]{10,})%22%29/);
        jsToken = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
        if (jsToken) {
          console.log(`[Anon] jsToken extracted from share page on ${domain}: ${jsToken.substring(0, 12)}...`);
        } else {
          console.log(`[Anon] No jsToken found on share page ${domain}, will try direct API call.`);
        }
      }
    } catch (pageErr) {
      console.warn(`[Anon] Share page fetch failed on ${domain}:`, pageErr.message);
    }

    // ── Step 2: Call /share/list directly ──
    try {
      const apiUrl = new URL(`${domain}/share/list`);
      apiUrl.search = new URLSearchParams({
        app_id: '250528',
        channel: 'dubox',
        clienttype: '0',
        jsToken: jsToken,
        shorturl: shortUrl,
        by: 'name',
        order: 'asc',
        num: 20000,
        dir: '',
        page: 1,
        dlink: 1,
        root: 1,
      }).toString();

      const listRes = await request(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Referer': `${domain}/`,
          'Accept': 'application/json, text/plain, */*',
        },
        dispatcher: redirectAgent,
        signal: AbortSignal.timeout(10000),
      });

      if (listRes.statusCode !== 200) {
        console.warn(`[Anon] ${domain} returned HTTP ${listRes.statusCode} for share/list. Skipping.`);
        await listRes.body.dump().catch(() => {});
        continue;
      }

      const rdata = await listRes.body.json();
      console.log(`[Anon] ${domain} share/list errno=${rdata.errno}`);

      // errno 0 = success
      if (rdata.errno === 0) {
        return rdata;
      }

      // errno 4000020 / 102 = verification / login required → try next domain
      if (rdata.errno === 4000020 || rdata.errno === 102) {
        console.warn(`[Anon] ${domain} requires verification (errno ${rdata.errno}). Trying next domain...`);
        continue;
      }

      // Other non-zero errnos (link expired, deleted etc.) — return as-is, no point retrying
      console.warn(`[Anon] ${domain} returned non-retryable errno ${rdata.errno}.`);
      return rdata;

    } catch (apiErr) {
      console.warn(`[Anon] ${domain} API call failed:`, apiErr.message);
    }
  }

  // All domains exhausted
  return { errno: 102, errmsg: 'All anonymous domains blocked or rate-limited. Please try again later.' };
}


// ── TIER ROUTING ──────────────────────────────────────────────────────────────
// Checks whether a given API key belongs to an active, non-expired paid
// subscription. Returns { isPremium: true, userId: email } or { isPremium: false }.
// The master API_KEY (used by the website) is treated as FREE tier.
// Only verified Razorpay-activated ApiSubscription tokens are PAID tier.
async function checkPremiumEntitlement(apiKey) {
  if (!apiKey) {
    console.log('[Entitlement] No API Key provided');
    return { isPremium: false, reason: 'unauthenticated' };
  }

  // Master API key check (free/anonymous website access)
  if (apiKey === process.env.API_KEY) {
    console.log('[Entitlement] Master API Key detected');
    return { isPremium: false, reason: 'master_key' };
  }

  try {
    await connectToDatabase();
    console.log('[Entitlement] Database connected. Parsing token...');

    // 1. Google Auth Stateless Session Token Check
    const decoded = verifySessionToken(apiKey);
    if (decoded && decoded.email) {
      const email = decoded.email.toLowerCase().trim();
      console.log(`[Entitlement] Decoded Google token: email=${email}, role=${decoded.role}`);
      
      const user = await User.findOne({ email });
      if (!user) {
        console.log(`[Entitlement] Google user not found in DB: ${email}`);
        return { isPremium: false, reason: 'user_not_found' };
      }

      console.log(`[Entitlement] User match: premiumStatus=${user.premiumStatus}, usesRemaining=${user.freePremiumUsesRemaining}`);

      // Check if user is active Premium
      const isPremiumUser = user.premiumStatus === 'premium' || user.plan === 'premium';
      const isExpired = user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date();

      if (isPremiumUser && !isExpired) {
        return { isPremium: true, userId: email, plan: user.plan || 'premium', userType: 'premium' };
      }

      if (isPremiumUser && isExpired) {
        user.plan = 'free';
        user.premiumStatus = 'expired';
        await user.save();
        return { isPremium: false, reason: 'premium_expired', userType: 'expired' };
      }

      // Check Free Trial uses remaining
      const trials = user.freePremiumUsesRemaining !== undefined ? user.freePremiumUsesRemaining : 3;
      if (trials > 0) {
        return { isPremium: true, userId: email, plan: 'free_trial', userType: 'free_trial', trialsRemaining: trials };
      }

      return { isPremium: false, reason: 'trials_exhausted', userType: 'free_trial', trialsRemaining: 0 };
    } else {
      console.log('[Entitlement] Token failed to decode via verifySessionToken');
    }

    // 2. Developer Subscription Token Check (Backward Compatibility)
    const sub = await ApiSubscription.findOne({ token: apiKey });
    if (sub) {
      console.log(`[Entitlement] Match Developer subscription token: status=${sub.status}`);
      if (sub.status !== 'active') return { isPremium: false, reason: 'inactive', status: sub.status };
      if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
        sub.status = 'expired';
        await sub.save();
        return { isPremium: false, reason: 'expired' };
      }
      return { isPremium: true, userId: sub.email, plan: sub.plan, userType: 'developer' };
    }

    console.log('[Entitlement] Token is neither Google session nor developer subscription');
    return { isPremium: false, reason: 'invalid_token' };
  } catch (err) {
    console.error('[Entitlement] Verification failed with exception:', err.message);
    return { isPremium: false, reason: 'db_error' };
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Atomically consumes 1 free premium trial use from Google user account.
// Concurrency safe (using Mongoose update condition). Returns true if successfully decremented.
export async function consumeFreeTrial(email) {
  try {
    await connectToDatabase();
    const updatedUser = await User.findOneAndUpdate(
      { email: email.toLowerCase().trim(), freePremiumUsesRemaining: { $gt: 0 } },
      { $inc: { freePremiumUsesRemaining: -1 } },
      { new: true }
    );
    if (updatedUser) {
      console.log(`[Trial] Consumed 1 free trial for ${email}. Remaining: ${updatedUser.freePremiumUsesRemaining}`);
      return true;
    }
  } catch (err) {
    console.error('[Trial] Atomic consumption failed:', err.message);
  }
  return false;
}

let autoLoginCooldownUntil = 0; // In-memory rate limit cooldown lock
let _ndusRefreshInFlight = null; // Single-flight promise lock: prevents concurrent login storms

// Function to refresh ndus token using credentials.
// Single-flight: if a refresh is already in progress, all callers await the same promise.
export async function refreshNdusToken(whost) {
  // ── Single-flight lock: if a refresh is already running, wait for it ──
  if (_ndusRefreshInFlight) {
    console.log('[NDUS Auto-Login] Refresh already in-flight. Waiting for existing promise...');
    return _ndusRefreshInFlight;
  }

  // ── Cooldown check: prevent rapid re-login after rate-limit response ──
  if (Date.now() < autoLoginCooldownUntil) {
    const remainingMin = Math.ceil((autoLoginCooldownUntil - Date.now()) / 60000);
    console.log(`[NDUS Auto-Login] Ignored. On cooldown for another ${remainingMin} min due to rate-limiting.`);
    return null;
  }

  // ── Start the actual refresh, wrapped in a single-flight promise ──
  _ndusRefreshInFlight = (async () => {
    try {
      const email = process.env.TERABOX_EMAIL || process.env.TERABOX_USER;
      const password = process.env.TERABOX_PASSWORD || process.env.TERABOX_PASS;

      if (!email || !password) {
        console.log('[NDUS Auto-Login] Missing credentials (TERABOX_EMAIL / TERABOX_PASSWORD) in env variables.');
        return null;
      }

      console.log(`[NDUS Auto-Login] Attempting passport login for email: ${email}`);
      const app = new TeraBoxApp('');
      app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box'];
      app.TERABOX_DOMAIN = tbDomains.some(d => whost.includes(d)) ? '1024terabox.com' : 'terabox.com';
      app.params.whost = whost;
      app.params.uhost = whost;

      const preLoginData = await app.passportPreLogin(email);
      const loginRes = await app.passportLogin(preLoginData, email, password);

      if (loginRes.code === 0 && loginRes.data && loginRes.data.ndus) {
        // Use FULL cookie string from login (ndus + browserid + csrf + all session cookies)
        const fullCookies = loginRes.data.cookies || `ndus=${loginRes.data.ndus}`;
        console.log('[NDUS Auto-Login] Success! New token generated.');
        console.log('[NDUS Auto-Login] Full cookies preview:', fullCookies.substring(0, 60) + '...');

        // Save full cookie string to MongoDB persistently
        try {
          await SystemConfig.findOneAndUpdate(
            { key: 'TERABOX_NDUS' },
            { value: fullCookies, updatedAt: new Date() },
            { upsert: true }
          );
          console.log('[NDUS Auto-Login] Saved full cookies to MongoDB configuration cache.');
        } catch (dbErr) {
          console.error('[NDUS Auto-Login] Failed to save to MongoDB:', dbErr.message);
        }
        return fullCookies;
      } else {
        console.error('[NDUS Auto-Login] Failed. Response:', JSON.stringify(loginRes));
        
        // Target verification / spam limit check to activate cooldown lock
        if (loginRes.code === 102 || String(loginRes.msg).includes('extra') || String(loginRes.msg).includes('verify')) {
          const timeoutSeconds = (loginRes.data && loginRes.data.spam_expire_in) || 1500;
          const safetyBuffer = 60; // 60 seconds safety buffer
          const cooldownMs = (timeoutSeconds + safetyBuffer) * 1000;
          autoLoginCooldownUntil = Date.now() + cooldownMs;
          console.warn(`[NDUS Auto-Login] TeraBox rate-limiting/spam lock detected! Locking logins for ${Math.ceil(cooldownMs / 60000)} minutes (spam_expire_in=${timeoutSeconds}s + 60s buffer).`);
        }
        return null;
      }
    } catch (loginErr) {
      console.error('[NDUS Auto-Login] Exception occurred:', loginErr.message);
      return null;
    } finally {
      // Always release the single-flight lock so future requests can retry
      _ndusRefreshInFlight = null;
    }
  })();

  return _ndusRefreshInFlight;
}

// Follow TeraBox dlink redirect to get actual CDN URL (faster download)
async function resolveCdnUrl(dlink, headers) {
  try {
    const response = await fetch(dlink, {
      method: 'GET',
      headers,
      redirect: 'manual', // Don't auto-follow, we want the Location header
    });
    // TeraBox returns 302 redirect to actual CDN URL
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location && location.startsWith('http')) {
        console.log('[CDN] Resolved redirect:', location.substring(0, 80) + '...');
        return location;
      }
    }
    // Already a direct URL or no redirect
    return dlink;
  } catch (e) {
    console.log('[CDN] Redirect resolve failed, using original dlink:', e.message);
    return dlink;
  }
}

const TB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Telegram alert on ndus token expiry
async function sendTelegramTokenAlert() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.CHAT_ID || "1892511025"; // Fallback to user ID from logs
  if (!botToken || !adminChatId) return;
  console.log(`[Telegram Alert] Sending token expiry warning to admin chat: ${adminChatId}`);
  fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminChatId,
      text: `⚠️ <b>TeraBox Premium Token Expired!</b>\n\nThe premium cookie session (ndus) has expired or been blocked by TeraBox. The API is temporarily running in public/anonymous fallback mode.\n\nPlease update <b>TERABOX_NDUS</b> in Vercel settings and redeploy immediately.`,
      parse_mode: 'HTML'
    })
  }).catch(err => console.error('[Telegram Alert] Failed:', err.message));
}

// Recover dlink via /share/download when /share/list omits it.
// TeraBox stopped returning dlink in share/list for many sessions; this signed
// endpoint still returns it for valid logged-in (ndus) sessions.
// Returns '' on any failure.
async function resolveDlinkViaShareDownload(whost, sign, timestamp, shareId, uk, fsId, cookie) {
  try {
    const dlUrl = new URL(`${whost}/share/download`);
    dlUrl.search = new URLSearchParams({
      app_id: '250528',
      web: '1',
      channel: 'dubian-wap',
      clienttype: '0',
      shareid: String(shareId),
      uk: String(uk),
      fid_list: JSON.stringify([fsId]),
      sign: sign || '',
      timestamp: String(timestamp || ''),
      product: 'share',
      nozip: '0',
      type: 'dlink',
    });
    const res = await fetch(dlUrl, {
      headers: {
        'User-Agent': TB_UA,
        'Referer': `${whost}/sharing/link?surl=`,
        'Cookie': cookie || `browserid=${Math.random().toString(36).substring(2)}`,
      },
      signal: AbortSignal.timeout(3000),
    });
    const j = await res.json();
    if (j && j.errno === 0 && j.dlink) {
      console.log('[Parse] dlink recovered via /share/download');
      return j.dlink;
    }
    console.log(`[Parse] /share/download fallback failed: errno=${j && j.errno} errmsg=${j && j.errmsg}`);
    return '';
  } catch (e) {
    console.log('[Parse] /share/download fallback error:', e.message);
    return '';
  }
}

// Helper to recursively fetch all files inside a directory (folder) in a TeraBox share link
// Uses the TeraBoxApp's shortUrlList method with undici TLS connector to bypass Cloudflare
async function fetchFolderFiles(app, shortUrl, dirPath, shareId, uk, browserId, ndusToken, depth = 0) {
  if (depth > 2) {
    console.warn(`[Folder Fetch] Max depth reached at: ${dirPath}`);
    return [];
  }
  try {
    console.log(`[Folder Fetch] Listing dir (depth=${depth}): ${dirPath}`);
    const rawShortUrl = shortUrl.replace(/^1/, '');
    const j = await app.shortUrlList(rawShortUrl, dirPath);
    console.log(`[Folder Fetch] Response for ${dirPath}: errno=${j && j.errno}, count=${j && j.list && j.list.length}`);
    if (j && j.errno === 0 && Array.isArray(j.list)) {
      // Separate dirs and files
      const dirs = j.list.filter(item => Number(item.isdir) === 1);
      const files = j.list.filter(item => Number(item.isdir) !== 1);

      // Fetch all subdirs in parallel
      const subResults = await Promise.all(
        dirs.map(dir => fetchFolderFiles(app, shortUrl, dir.path, shareId, uk, browserId, ndusToken, depth + 1))
      );
      return files.concat(...subResults);
    }
    console.warn(`[Folder Fetch] errno=${j && j.errno} errmsg=${j && j.errmsg} for dir ${dirPath}`);
    return [];
  } catch (e) {
    console.error(`[Folder Fetch] Failed for ${dirPath}:`, e.message);
    return [];
  }
}



export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Dynamic API Kill Switch: Check process.env.API_STATUS toggle configured in Vercel environment variables
  if (process.env.API_STATUS === 'off') {
    console.log('[API Status] Kill switch is active (off) via Vercel env. Serving 503 temporarily unavailable...');
    return res.status(503).json({
      error: "API is temporarily offline for maintenance. Please check back later."
    });
  }

  // Extract siteOrigin from referer or fallback to default domain
  let siteOrigin = 'https://teraboxdownloader.co.in';
  if (req.headers.referer) {
    try {
      const refUrl = new URL(req.headers.referer);
      siteOrigin = refUrl.origin;
    } catch (e) {
      // ignore
    }
  }

  // Security Check: Validate API Key / Subscription Token
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const expectedKey = process.env.API_KEY;

  // Verify if it is a Google Auth session token first
  const isGoogleSession = verifySessionToken(apiKey);

  if (apiKey !== expectedKey && !isGoogleSession) {
    if (!apiKey) {
      return res.status(403).json({ error: "Access denied. Missing API key." });
    }

    try {
      await connectToDatabase();
      const subscription = await ApiSubscription.findOne({ token: apiKey });

      if (!subscription || subscription.status !== 'active') {
        return res.status(403).json({ error: "Access denied. Invalid or inactive subscription token." });
      }

      // Check Expiry
      if (subscription.expiresAt && new Date(subscription.expiresAt) < new Date()) {
        subscription.status = 'expired';
        await subscription.save();
        return res.status(403).json({ error: "Access denied. Subscription token has expired." });
      }

      // Check and Reset daily quota
      const now = new Date();
      const lastReset = new Date(subscription.lastReset);
      const isNewDay = now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
                        now.getUTCMonth() !== lastReset.getUTCMonth() ||
                        now.getUTCDate() !== lastReset.getUTCDate();

      if (isNewDay) {
        subscription.requestCount = 0;
        subscription.lastReset = now;
      }

      // Check daily limit
      if (subscription.requestCount >= subscription.requestLimit) {
        await subscription.save();
        return res.status(429).json({ error: "Daily request limit exceeded for this plan. Please upgrade." });
      }

      // Increment request count
      subscription.requestCount += 1;
      await subscription.save();

    } catch (dbErr) {
      console.error('[DB] Token verification failed:', dbErr.message);
      return res.status(500).json({ error: "Internal security validation error." });
    }
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  const cleanUrl = url.trim().replace(/[\s\r\n\t]/g, '');
  const fromSource = req.query.from || 'unknown';
  console.log(`[Parse] Request URL: ${cleanUrl} | Source: ${fromSource}`);

  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    recordPageView(ip).catch(e => console.error('[DB] recordPageView error:', e));

    const lowerUrl = cleanUrl.toLowerCase();

    // 1. YouTube Downloader
    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
      // Swap priority: Try btch-downloader first for high-speed conversion proxy links (no IP throttle).
      // Fall back to ytdl-core only if btch-downloader fails.
      let yt = null;
      try {
        const fb = await youtube(cleanUrl);
        if (fb && fb.status && fb.mp4) {
          yt = { ...fb, mp4Size: 0, mp3Size: 0 };
        }
      } catch (e) {
        console.log(`[Parse] btch-downloader youtube failed, trying ytdl-core:`, e.message);
      }

      if (!yt || !yt.mp4) {
        try {
          const info = await ytdl.getInfo(cleanUrl, { requestOptions: { timeout: 20000 } });
          const video = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
          const audio = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
          if (video && video.url) {
            yt = {
              status: true,
              title: info.videoDetails.title,
              thumbnail: (info.videoDetails.thumbnails && info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url) || '',
              mp4: video.url,
              mp4Size: video.contentLength,
              mp3: audio && audio.url ? audio.url : '',
              mp3Size: audio ? audio.contentLength : 0,
            };
          }
        } catch (err) {
          console.log(`[Parse] ytdl-core fallback failed:`, err.message);
        }
      }

      if (!yt || !yt.mp4) {
        throw new Error('YouTube resolution failed. Please verify the URL and try again.');
      }

      return res.status(200).json({
        list: [
          {
            name: `${yt.title || 'YouTube_Video'} (Video - MP4)`,
            size: yt.mp4Size ? formatBytes(Number(yt.mp4Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp4 || '',
          },
          {
            name: `${yt.title || 'YouTube_Video'} (Audio - MP3)`,
            size: yt.mp3Size ? formatBytes(Number(yt.mp3Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp3 || '',
          }
        ]
      });
    }

    // 2. Instagram Downloader
    if (lowerUrl.includes('instagram.com')) {
      console.log(`Resolving Instagram URL: ${cleanUrl}...`);
      let data;
      try {
        const apiRes = await fetch(`https://backend1.tioo.eu.org/igdl?url=${encodeURIComponent(cleanUrl)}`);
        data = await apiRes.json();
      } catch (err) {
        // Fallback to SDK
        const sdkRes = await igdl(cleanUrl);
        data = sdkRes.result || sdkRes;
      }
      
      const list = Array.isArray(data) ? data : (data.result || []);
      const first = list[0];
      if (!first) {
        throw new Error('No media files found in this Instagram post');
      }

      let caption = (data && data.caption) || (first && first.caption) || '';
      if (caption.length > 60) {
        caption = caption.substring(0, 60).trim() + '...';
      }
      const igTitle = caption ? `${caption} (Instagram).mp4` : `Instagram_Video_${Date.now().toString().slice(-4)}.mp4`;
      const igThumbnail = first.thumbnail || first.thumbnail_url || first.preview || '';

      return res.status(200).json({
        list: [{
          name: igTitle,
          size: 'Unknown',
          thumbnail: igThumbnail,
          dlink: first.url || first.dlink || '',
        }]
      });
    }

    // 3. TikTok Downloader
    if (lowerUrl.includes('tiktok.com')) {
      const tt = await ttdl(cleanUrl);
      if (!tt.status) {
        throw new Error(tt.message || 'TikTok resolution failed');
      }
      const videoUrl = Array.isArray(tt.video) ? tt.video[0] : tt.video;
      if (!videoUrl) {
        throw new Error('No video found in this TikTok');
      }
      return res.status(200).json({
        list: [{
          name: tt.title || 'TikTok_Video.mp4',
          size: 'Unknown',
          thumbnail: tt.thumbnail || '',
          dlink: videoUrl,
        }]
      });
    }

    // 4. Facebook Downloader
    if (lowerUrl.includes('facebook.com') || lowerUrl.includes('fb.watch') || lowerUrl.includes('fb.gg')) {
      console.log(`Resolving Facebook URL: ${cleanUrl}...`);
      let data;
      try {
        const apiRes = await fetch(`https://backend1.tioo.eu.org/fbdown?url=${encodeURIComponent(cleanUrl)}`);
        data = await apiRes.json();
      } catch (err) {
        data = await fbdown(cleanUrl);
      }

      const videoUrl = data.HD || data.Normal_video || data.url;
      if (!videoUrl) {
        throw new Error('No video found in this Facebook post');
      }

      let title = data.title || data.caption || 'Facebook_Video';
      if (title.length > 60) {
        title = title.substring(0, 60).trim() + '...';
      }
      const fbThumbnail = data.thumbnail || data.cover || data.image || data.thumb || '';

      return res.status(200).json({
        list: [{
          name: title.endsWith('.mp4') ? title : `${title}.mp4`,
          size: 'Unknown',
          thumbnail: fbThumbnail,
          dlink: videoUrl,
        }]
      });
    }

    // Default to TeraBox
    let shortUrl = "";
    const sMatch = cleanUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
    const surlMatch = cleanUrl.match(/surl=([A-Za-z0-9_-]+)/);

    if (sMatch) {
      shortUrl = sMatch[1];
    } else if (surlMatch) {
      shortUrl = surlMatch[1];
    }

    if (!shortUrl) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox, YouTube, Instagram, Facebook, or TikTok link." });
    }

    // Always strip the leading '1' from the shortUrl because the /share/list API expects the raw surl token
    const strippedShortUrl = shortUrl.replace(/^1/, '');

    // ─── CACHE CHECK (Execute first to protect trials & prevent load) ───
    try {
      await connectToDatabase();
      const cachedRecord = await LinkCache.findOne({ shortUrl: strippedShortUrl });
      if (cachedRecord && cachedRecord.response) {
        console.log(`[Cache Hit] Serving cached response for surl: ${strippedShortUrl}. Trials will NOT be decremented.`);
        return res.status(200).json(cachedRecord.response);
      }
    } catch (cacheErr) {
      console.error('[Cache Read Error] Failed to read from cache:', cacheErr.message);
    }

    // ── ENTITLEMENT CHECK (Only execute if cache misses) ──────────────────────
    const entitlement = await checkPremiumEntitlement(apiKey);
    let isPremium = entitlement.isPremium;
    console.log(`[ROUTER] apiKey=${apiKey ? apiKey.substring(0,8)+'...' : 'none'} entitlement=${isPremium ? 'paid('+entitlement.plan+')' : 'free('+entitlement.reason+')'}`);
    
    // Support x-user-tier header from Firebase Auth frontend
    const tierHeader = req.headers['x-user-tier'];
    if (tierHeader && (tierHeader === 'premium' || tierHeader === 'free')) {
      if (tierHeader === 'premium') {
        entitlement.isPremium = true;
        entitlement.plan = 'premium';
        entitlement.userType = 'premium';
      } else {
        entitlement.isPremium = false;
        entitlement.reason = 'free';
        entitlement.userType = 'free';
        entitlement.trialsRemaining = 3;
      }
      isPremium = tierHeader === 'premium';
      console.log(`[ROUTER] Using tier from header: ${tierHeader}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    let listData = null;
    let tokenExpiredDetected = false;
    let dlinkRecoveryFailed = false;

    // Always use 1024terabox.com to prevent cookie stripping redirects on Vercel
    const anonApp = {
      params: {
        whost: 'https://www.1024terabox.com',
        uhost: 'https://c-all.1024terabox.com',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      TERABOX_DOMAIN: '1024terabox.com'
    };

    // ── TIER-BASED ROUTING ────────────────────────────────────────────────────
    // PAID users → Premium NDUS route (fast CDN, streaming, dlink recovery)
    // FREE users → Anonymous-only route (NO ndus, NO premium fallback)
    //
    // CRITICAL: FREE requests must NEVER silently fall through to Premium NDUS.
    // ─────────────────────────────────────────────────────────────────────────

    let premiumApp = null; // Will hold the authenticated TeraBoxApp instance for folder listing

    if (isPremium) {
      // ── PREMIUM ROUTE ──
      console.log(`[ROUTER] user=${entitlement.userId || 'api'} feature=parse entitlement=paid`);
      console.log('[ROUTER] Using premium route (NDUS session)...');
      let ndusToken = await getNdusToken();
      let autoLoginAttempted = false;

      // Bootstrap: no token anywhere? Try auto-login for self-start.
      if (!ndusToken) {
        console.log('[Premium] No ndus token found. Trying credential bootstrap...');
        ndusToken = await refreshNdusToken(anonApp.params.whost) || '';
        autoLoginAttempted = true;
      }

      if (ndusToken) {
        let app = new TeraBoxApp(ndusToken);
        app.params.ua = anonApp.params.ua;
        app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
        app.params.whost = anonApp.params.whost;
        app.params.uhost = anonApp.params.uhost;
        premiumApp = app;

        try {
          let ndusData = await app.shortUrlList(strippedShortUrl);
          console.log('[Premium] NDUS session response:', JSON.stringify(ndusData));

          // Link expiry check BEFORE token refresh
          const isLinkExpired = ndusData && (
            ndusData.errno === 140 || ndusData.errno === -140 ||
            ndusData.errno === 116 || ndusData.errno === 117 ||
            ndusData.errno === 12  || ndusData.errno === 110 ||
            ndusData.errno === -110 ||
            String(ndusData.errmsg || '').toLowerCase().includes('delete') ||
            String(ndusData.errmsg || '').toLowerCase().includes('expire') ||
            String(ndusData.errmsg || '').toLowerCase().includes('not exist')
          );

          if (isLinkExpired) {
            console.log('[Premium] Link is expired or deleted. Skipping token refresh.');
            listData = ndusData;
          } else if (ndusData && ndusData.errno === 400141) {
            if (!autoLoginAttempted) {
              console.log('[Premium] 400141 token challenge. Attempting single-flight refresh...');
              const freshToken = await refreshNdusToken(anonApp.params.whost);
              autoLoginAttempted = true;
              if (freshToken) {
                ndusToken = freshToken;
                app = new TeraBoxApp(ndusToken);
                app.params.ua = anonApp.params.ua;
                app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
                app.params.whost = anonApp.params.whost;
                app.params.uhost = anonApp.params.uhost;
                ndusData = await app.shortUrlList(strippedShortUrl);
                console.log('[Premium] Retry NDUS response:', JSON.stringify(ndusData));
              }
            } else {
              console.log('[Premium] Auto-login already attempted. Skipping duplicate refresh.');
            }
          }

          if (ndusData && ndusData.errno === 0) {
            listData = ndusData;
          } else if (ndusData && !isLinkExpired) {
            tokenExpiredDetected = true;
            console.warn(`[Premium] Token returned error code ${ndusData.errno}.`);
          }
        } catch (e) {
          console.error('[Premium] NDUS session failed:', e.message);
        }
      }

      // Premium fallback: if NDUS failed, try anonymous (only for paid users)
      if (!listData || listData.errno !== 0) {
        console.log('[Premium] NDUS failed. Attempting anonymous fallback for paid user...');
        try {
          const anonFallback = new TeraBoxApp('');
          anonFallback.params.ua = anonApp.params.ua;
          anonFallback.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
          anonFallback.params.whost = anonApp.params.whost;
          anonFallback.params.uhost = anonApp.params.uhost;
          const anonRes = await anonFallback.shortUrlList(strippedShortUrl);
          console.log('[Premium] Anonymous fallback response:', JSON.stringify(anonRes));
          if (anonRes && anonRes.errno === 0) listData = anonRes;
        } catch (anonErr) {
          console.error('[Premium] Anonymous fallback failed:', anonErr.message);
        }
      }

    } else {
      // ── FREE / ANONYMOUS ROUTE ──
      // NO ndus token. NO premium fallback. NO NDUS credentials touched.
      // Uses multi-domain fallback: extracts jsToken from share page itself,
      // then calls /share/list directly across multiple TeraBox mirror domains.
      console.log('[ROUTER] Using anonymous route (free tier). Premium NDUS will NOT be contacted.');
      try {
        const freeRes = await fetchAnonShareList(strippedShortUrl);
        console.log('[Free] Anonymous TeraBox response errno:', freeRes?.errno);
        // Accept even partial results (errno may be 0 with empty list for some mirrors)
        listData = freeRes;
      } catch (freeErr) {
        console.error('[Free] Anonymous TeraBox failed:', freeErr.message);
      }
    }

    // Trigger Telegram notification if token expiry is detected
    if (tokenExpiredDetected) {
      sendTelegramTokenAlert().catch(err => console.error('[Telegram] Alert failed:', err.message));
      tokenExpiredDetected = false;
    }

// Failsafe Fallback: If both failed, but anonymous returned a list (even without dlink), use it as fallback
    if ((!listData || listData.errno !== 0) && listData && listData.list) {
      listData.errno = 0; // Bypass error block to return whatever metadata we got
    }

    if (!listData || listData.errno !== 0) {
      if (listData) {
        const errmsg = String(listData.errmsg || '').toLowerCase();
        const errno = listData.errno;

        // ── SHARE_UNAVAILABLE: link actually expired/deleted/cancelled ──
        if (errno === 140 || errno === -140 || errno === 116 || errno === 117 || 
            errno === 12 || errno === 110 || errno === -110 || 
            errmsg.includes('delete') || errmsg.includes('expire') || errmsg.includes('not exist')) {
          return res.status(404).json({
            success: false,
            code: 'SHARE_UNAVAILABLE',
            message: 'This shared link is expired or unavailable.'
          });
        }

        // ── TERABOX_VERIFICATION_REQUIRED: 400141 or need verify ──
        if (errno === 400141 || errmsg.includes('need verify') || errmsg.includes('verify_v2')) {
          const vUrl = (listData.data && listData.data.verify_url) || (listData.data && listData.data.verifyUrl) || '';
          return res.status(503).json({
            success: false,
            code: 'TERABOX_VERIFICATION_REQUIRED',
            message: 'TeraBox verification is currently required. Please solve the captcha challenge.',
            verify_url: vUrl
          });
        }

        // ── TERABOX_RATE_LIMITED: code 102 / hit extra ──
        if (errno === 102 || errmsg.includes('hit extra') || errmsg.includes('spam')) {
          const retryAfter = (listData.data && listData.data.spam_expire_in) || 1500;
          return res.status(429).json({
            success: false,
            code: 'TERABOX_RATE_LIMITED',
            retry_after: retryAfter
          });
        }

        // ── Password-protected ──
        if (errno === -9 || errno === 2130 || errno === -2130) {
          return res.status(400).json({ error: 'This link requires a password. Password-protected links are currently not supported.' });
        }

        // ── Not found ──
        if (errno === 105 || errno === -6) {
          return res.status(400).json({ error: 'Shared link not found or invalid. Please check the URL format.' });
        }

        // ── Generic fallback ──
        return res.status(400).json({ error: `TeraBox API returned error code ${errno}. ${listData.errmsg || ''}` });
      }
      return res.status(400).json({ error: 'Failed to parse the link. Please verify the URL or try again later.' });
    }

    // Only fetch NDUS token for PAID users — FREE users must NEVER use premium credentials
    // This gates streaming, dlink recovery, and HLS resolution for the file processing below.
    let ndusToken = isPremium ? await getNdusToken() : '';
    if (!isPremium) {
      console.log('[ROUTER] Free tier: ndusToken withheld. Streaming and premium dlink will be skipped.');
    }

    // Generate a single browserid session token
    const browserId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

    // Fetch the correct sign and timestamp metadata for streaming using direct request with browserid
    let sign = '';
    let timestamp = '';
    try {
      const infoUrl = `${anonApp.params.whost}/api/shorturlinfo?shorturl=1${strippedShortUrl}&root=1`;
      const infoRes = await fetch(infoUrl, {
        signal: AbortSignal.timeout(2000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': `browserid=${browserId}`,
          'Referer': `${anonApp.params.whost}/`
        }
      });
      const infoData = await infoRes.json();
      if (infoData && infoData.errno === 0) {
        sign = infoData.sign || '';
        timestamp = infoData.timestamp || '';
      }
    } catch (infoErr) {
      console.error('[Parse] Failed to fetch shortUrlInfo metadata:', infoErr.message);
    }

    // If any items are directories (folders), recursively fetch files inside them (parallel)
    if (listData && Array.isArray(listData.list)) {
      const topDirs = listData.list.filter(f => Number(f.isdir) === 1);
      const topFiles = listData.list.filter(f => Number(f.isdir) !== 1);

      if (topDirs.length > 0) {
        console.log(`[Parse] Found ${topDirs.length} top-level director(ies). Fetching in parallel...`);
        const dirResults = await Promise.all(
          topDirs.map(dir => {
            console.log(`[Parse] Fetching dir: ${dir.server_filename}`);
            return fetchFolderFiles(
              premiumApp || anonApp, `1${strippedShortUrl}`, dir.path,
              listData.share_id || listData.shareid, listData.uk,
              browserId, ndusToken, 0
            );
          })
        );
        listData.list = topFiles.concat(...dirResults);
        console.log(`[Parse] Total files after folder expansion: ${listData.list.length}`);
        listData._isFolderExpanded = true; // Flag to skip heavy per-file processing
      }
    }

    const isFolderExpanded = !!listData._isFolderExpanded;

    const formattedList = await Promise.all((listData.list || []).map(async (file) => {
      // ── PROTECTION 1: Adult content block ──
      // Must happen BEFORE any dlink, stream, HLS, or token operations.
      const isAdultRaw = file.is_adult;
      if (isAdultRaw === 1 || isAdultRaw === '1' || Number(isAdultRaw) === 1) {
        console.warn(`[Parse] Adult content detected (is_adult=${isAdultRaw}) for file: ${file.server_filename}. Blocking.`);
        return {
          name: file.server_filename || 'file',
          size: file.size ? formatBytes(Number(file.size)) : 'Unknown',
          thumbnail: '',
          dlink: '',
          stream_url: '',
          status: 'content_restricted',
          error_code: 'CONTENT_RESTRICTED',
          error_message: 'This content cannot be streamed through this service.',
        };
      }

      const ext = file.server_filename?.split('.').pop()?.toLowerCase();
      const isVideo = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi', 'ts', 'wmv', '3gp', 'flv'].includes(ext);
      let streamUrl = '';
      let debugStreamEndpoint = '';
      let debugStreamData = null;
      let autoLoginAttempted = false;

      // For folder-expanded files, fetch dlink via share/download (use cached sign/timestamp)
      if (isFolderExpanded) {
        const thumbObj = file.thumbs || {};
        const thumb = thumbObj.url1 || thumbObj.url2 || thumbObj.icon_url || file.thumbnail || '';
        const ext = file.server_filename?.split('.').pop()?.toLowerCase();
        const isVid = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi', 'ts', 'wmv', '3gp', 'flv'].includes(ext);

        let folderDlink = file.dlink || '';
        if (!folderDlink && sign && timestamp && listData.share_id && listData.uk && file.fs_id) {
          const sessionCookie = buildCookie(ndusToken, browserId);
          folderDlink = await resolveDlinkViaShareDownload(
            anonApp.params.whost, sign, timestamp,
            listData.share_id || listData.shareid, listData.uk,
            file.fs_id, sessionCookie
          );
          if (!folderDlink) {
            folderDlink = await resolveDlinkViaShareDownload(
              anonApp.params.whost, sign, timestamp,
              listData.share_id || listData.shareid, listData.uk,
              file.fs_id, `browserid=${browserId}`
            );
          }
        }

        return {
          name: file.server_filename || 'Unknown',
          size: formatBytes(Number(file.size) || 0),
          thumbnail: thumb,
          dlink: folderDlink || '',
          stream_url: (isVid && folderDlink) ? '' : '',
          status: folderDlink ? 'ok' : 'folder_file',
          fs_id: file.fs_id,
          path: file.path,
        };
      }

      // Recover missing dlink via the signed /share/download endpoint
      // (share/list no longer returns dlink for many sessions)
      // Only execute this recovery step if we have a premium ndusToken (since anonymous calls trigger verify_v2 captcha loop)
      let dlink = file.dlink || '';
      let verifyV2Url = '';

      if (!dlink && ndusToken && sign && timestamp && listData.share_id && listData.uk && file.fs_id) {
        const sessionCookie = buildCookie(ndusToken, browserId);
        
        // Fetch raw response to check for verify_url on failure
        const dlUrl = new URL(`${anonApp.params.whost}/share/download`);
        dlUrl.search = new URLSearchParams({
          app_id: '250528',
          web: '1',
          channel: 'dubian-wap',
          clienttype: '0',
          shareid: String(listData.share_id || listData.shareid),
          uk: String(listData.uk),
          fid_list: JSON.stringify([file.fs_id]),
          sign: sign || '',
          timestamp: String(timestamp || ''),
          product: 'share',
          nozip: '0',
          type: 'dlink',
        });
        
        try {
          const res = await fetch(dlUrl, {
            headers: {
              'User-Agent': TB_UA,
              'Referer': `${anonApp.params.whost}/sharing/link?surl=`,
              'Cookie': sessionCookie,
            },
            signal: AbortSignal.timeout(3000),
          });
          const j = await res.json();
          if (j && j.errno === 0 && j.dlink) {
            dlink = j.dlink;
          } else {
            console.log(`[Parse] /share/download fallback failed: errno=${j && j.errno}`);
            if (j && (j.errno === 400310 || String(j.errmsg || '').includes('verify_v2'))) {
              verifyV2Url = (j.data && (j.data.verify_url || j.data.verifyUrl)) || '';
            }
          }
        } catch (e) {
          console.log('[Parse] /share/download fallback fetch error:', e.message);
        }

        if (!dlink && ndusToken && !verifyV2Url) {
          console.log('[Parse] Premium dlink recovery failed. Trying anonymous recovery...');
          dlink = await resolveDlinkViaShareDownload(
            anonApp.params.whost, sign, timestamp,
            listData.share_id || listData.shareid, listData.uk,
            file.fs_id, `browserid=${browserId}`
          );
        }
        
        if (!dlink && ndusToken) {
          dlinkRecoveryFailed = true;
        }
      }

      // If CAPTCHA challenge verify_v2 url was captured, return the verification required structure immediately
      if (verifyV2Url) {
        throw { isCaptchaChallenge: true, verifyUrl: verifyV2Url };
      }

      if (isVideo && ndusToken) {
        try {
          let app = new TeraBoxApp(ndusToken);
          app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
          app.params.whost = anonApp.params.whost;
          app.params.uhost = anonApp.params.uhost;

          let streamData;
          if (listData.share_id && listData.uk) {
            // Use the shared streaming endpoint which is optimized for shared links and pass sign/timestamp verification signatures along with the browserid session cookie
            debugStreamEndpoint = `${app.params.whost}/share/streaming?app_id=250528&web=1&channel=dubian-wap&clienttype=0&path=${encodeURIComponent(file.path || '')}&fid=${file.fs_id || ''}&uk=${listData.uk}&shareid=${listData.share_id}&sign=${sign}&timestamp=${timestamp}&type=M3U8_AUTO_480&vip=1`;
            const sRes = await fetch(debugStreamEndpoint, {
              signal: AbortSignal.timeout(3000),
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Cookie': `browserid=${browserId}; ndus=${ndusToken}`,
                'Referer': `https://www.${app.TERABOX_DOMAIN}/`
              }
            });
            
            const contentType = sRes.headers.get('content-type') || '';
            if (contentType.includes('json')) {
              streamData = await sRes.json();
            } else {
              let textContent = await sRes.text();
              if (textContent.startsWith('#EXTM3U')) {
                // Rewrite absolute CDN URLs to go through the local domain's download proxy to bypass CORS restrictions
                textContent = textContent.replace(/^(https?:\/\/[^\s\r\n]+)/gm, (match) => {
                  return `${siteOrigin}/download.php?url=${encodeURIComponent(match)}&filename=segment.ts`;
                });
                streamUrl = 'data:application/x-mpegURL;base64,' + Buffer.from(textContent).toString('base64');
                streamData = { m3u8: streamUrl };
              } else {
                streamData = { error: textContent };
              }
            }

            // ── Stream error handling: 400310 = need verify_v2 → stop immediately, no retry ──
            if (streamData && (streamData.errno === 400310 || String(streamData.errmsg || '').includes('verify_v2'))) {
              console.warn('[Stream] errno=400310 need verify_v2. Stopping — no retry.');
              streamUrl = '';
            // ── 400141 = token expired → ONE single-flight refresh attempt ──
            } else if (streamData && streamData.errno === 400141 && !autoLoginAttempted) {
              console.log('[Stream] share/streaming returned 400141 need verify. Attempting single-flight token refresh...');
              // Check cooldown BEFORE attempting refresh
              if (Date.now() < autoLoginCooldownUntil) {
                const remMin = Math.ceil((autoLoginCooldownUntil - Date.now()) / 60000);
                console.warn(`[Stream] Cooldown active. Skipping refresh for ${remMin} more min.`);
                streamUrl = '';
              } else {
                const freshToken = await refreshNdusToken(app.params.whost);
                autoLoginAttempted = true; // Prevent any further refresh attempts for this file
                if (freshToken) {
                  ndusToken = freshToken;
                  app = new TeraBoxApp(ndusToken);
                  app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
                  app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
                  app.params.whost = anonApp.params.whost;
                  app.params.uhost = anonApp.params.uhost;

                  const retryRes = await fetch(debugStreamEndpoint, {
                    signal: AbortSignal.timeout(3000),
                    headers: {
                      'User-Agent': app.params.ua,
                      'Cookie': buildCookie(ndusToken, browserId),
                      'Referer': `https://www.${app.TERABOX_DOMAIN}/`
                    }
                  });

                  const retryContentType = retryRes.headers.get('content-type') || '';
                  if (retryContentType.includes('json')) {
                    streamData = await retryRes.json();
                    // If refresh itself returned a rate-limit, stop here
                    if (streamData && (streamData.errno === 400310 || streamData.errno === 400141)) {
                      console.warn(`[Stream] Retry returned errno=${streamData.errno}. Giving up.`);
                      streamUrl = '';
                      streamData = null;
                    }
                  } else {
                    let retryText = await retryRes.text();
                    if (retryText.startsWith('#EXTM3U')) {
                      // Rewrite absolute CDN URLs to go through the local domain's download proxy to bypass CORS restrictions
                      retryText = retryText.replace(/^(https?:\/\/[^\s\r\n]+)/gm, (match) => {
                        return `${siteOrigin}/download.php?url=${encodeURIComponent(match)}&filename=segment.ts`;
                      });
                      streamUrl = 'data:application/x-mpegURL;base64,' + Buffer.from(retryText).toString('base64');
                      streamData = { m3u8: streamUrl };
                    } else {
                      streamData = { error: retryText };
                    }
                  }
                }
              }
            }
          } else {
            // Fallback to personal file stream endpoint
            streamData = await app.getStream(file.path || file.server_filename || '', 'M3U8_AUTO_480');
          }

          debugStreamData = streamData;

          if (streamData && streamData.m3u8) {
            streamUrl = streamData.m3u8;
          } else if (streamData && streamData.result && streamData.result.m3u8) {
            streamUrl = streamData.result.m3u8;
          } else if (streamData && streamData.url) {
            streamUrl = streamData.url;
          }
        } catch (streamErr) {
          console.error('[Stream] Failed to resolve HLS stream:', streamErr.message);
          streamUrl = 'ERROR: ' + streamErr.message;
        }
      }

      return {
        name: file.server_filename || 'video.mp4',
        size: file.size ? formatBytes(Number(file.size)) : 'Unknown',
        thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
        dlink: dlink,
        stream_url: streamUrl,
        // Mark file as unavailable if both download and stream failed
        status: (!dlink && (!streamUrl || streamUrl.startsWith('ERROR:'))) ? 'unavailable' : 'ok',
        debug_sign: sign,
        debug_timestamp: timestamp,
        debug_stream_endpoint: debugStreamEndpoint,
        debug_stream_data: debugStreamData
      };
    }));

    // If dlink recovery still failed with a session present, the token is
    // almost certainly expired -> alert admin (deduplicated per request)
    if (dlinkRecoveryFailed) {
      sendTelegramTokenAlert().catch(err => console.error('[Telegram] Alert failed:', err.message));
    }

    // Prepare the final payload response
    const payload = {
      list: formattedList,
      listData_keys: listData ? Object.keys(listData) : [],
      listData_share_id: listData ? listData.share_id : null,
      listData_shareid: listData ? listData.shareid : null,
      listData_uk: listData ? listData.uk : null,
      first_file_keys: (listData && listData.list && listData.list[0]) ? Object.keys(listData.list[0]) : [],
      first_file_server_filename: (listData && listData.list && listData.list[0]) ? listData.list[0].server_filename : null,
      first_file_filename: (listData && listData.list && listData.list[0]) ? listData.list[0].filename : null,
      first_file_name: (listData && listData.list && listData.list[0]) ? listData.list[0].name : null,
      downloadHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': buildCookie(ndusToken),
        'Accept': '*/*',
        'Connection': 'keep-alive',
        'Referer': `https://www.${anonApp.TERABOX_DOMAIN}/`,
      }
    };

    // ── ATOMIC TRIAL CONSUMPTION ─────────────────────────────────────────────
    // If user is on a free trial plan and successfully resolved a premium video stream,
    // consume 1 trial use atomically. If consumption fails (e.g. concurrent race condition),
    // we revoke the stream URL and return PREMIUM_REQUIRED.
    if (isPremium && entitlement.userType === 'free_trial') {
      const hasResolvedStream = formattedList.some(item => item.stream_url && !item.stream_url.startsWith('ERROR'));
      if (hasResolvedStream) {
        const success = await consumeFreeTrial(entitlement.userId);
        if (!success) {
          console.warn(`[Trial] Trial consumption failed for ${entitlement.userId} (trials exhausted). Revoking stream.`);
          formattedList.forEach(item => {
            item.stream_url = '';
          });
          return res.status(403).json({
            success: false,
            code: 'PREMIUM_REQUIRED',
            message: 'You have exhausted your 3 free premium trials. Please buy a plan to continue.'
          });
        } else {
          entitlement.trialsRemaining -= 1;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Save payload to MongoDB Cache (only if it has valid downloadable content and no errors)
    const hasValidCdn = formattedList.some(
      item => item.status === 'ok' && item.dlink && 
              item.error_code !== 'CONTENT_RESTRICTED' && 
              item.error_code !== 'TERABOX_VERIFICATION_REQUIRED' &&
              item.error_code !== 'TERABOX_RATE_LIMITED' &&
              item.error_code !== 'SHARE_UNAVAILABLE'
    );
    if (hasValidCdn) {
      try {
        await LinkCache.findOneAndUpdate(
          { shortUrl: strippedShortUrl },
          { response: payload, createdAt: new Date() },
          { upsert: true, new: true }
        );
        console.log(`[Cache Save] Successfully cached resolved response for surl: ${strippedShortUrl}`);
      } catch (cacheErr) {
        console.error('[Cache Save Error] Failed to write response to cache:', cacheErr.message);
      }
    }

    return res.status(200).json(payload);
  } catch (error) {
    if (error && error.isCaptchaChallenge) {
      return res.status(503).json({
        success: false,
        code: 'TERABOX_VERIFICATION_REQUIRED',
        message: 'TeraBox verification is currently required. Please solve the captcha challenge.',
        verify_url: error.verifyUrl
      });
    }
    return res.status(500).json({
      error: error.message || "Failed to resolve link. Please verify the URL and try again.",
    });
  }
}
