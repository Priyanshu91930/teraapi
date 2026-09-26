import { TeraBoxApp } from '../api.js';
import ytdl from '@distube/ytdl-core';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';
import { recordPageView, connectToDatabase, ApiSubscription, SystemConfig, LinkCache, User } from '../db.js';
import { verifySessionToken } from './auth/me.js';
import crypto from 'node:crypto';
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

let _globalProxyConfigured = false;
export function setupWebshareProxy() {
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl && !_globalProxyConfigured) {
    try {
      const defaultDispatcher = getGlobalDispatcher();
      const proxyAgent = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: false }
      });

      const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box','terabox'];

      const scopedDispatcher = {
        dispatch(opts, handler) {
          const host = (opts.origin ? String(opts.origin) : (opts.headers && opts.headers.host) || '').toLowerCase();
          
          // Exclude CDN download/streaming subdomains (e.g. d8.freeterabox.com, d.terabox.app)
          // CDN links use pre-signed tokens and don't need proxying, which saves bandwidth (KB instead of MB).
          const isCdn = /(?:^|\/\/)(?:d\d*|cdn\d*|download\d*)\./i.test(host);

          const isTeraBox = tbDomains.some(d => host.includes(d));
          if (isTeraBox && !isCdn) {
            return proxyAgent.dispatch(opts, handler);
          }
          return defaultDispatcher.dispatch(opts, handler);
        }
      };

      setGlobalDispatcher(scopedDispatcher);
      _globalProxyConfigured = true;
      const masked = proxyUrl.replace(/:[^:@]+@/, ':****@');
      console.log(`[Webshare Proxy] 🌐 Scoped ProxyAgent attached ONLY to TeraBox domains: ${masked}`);
    } catch (err) {
      console.error('[Webshare Proxy] Failed to attach scoped ProxyAgent dispatcher:', err.message);
    }
  }
}
setupWebshareProxy();

let _browserSolverMod = null;
async function safeSolveChallengeWithBrowser(verifyUrl, ndusToken) {
  try {
    if (!_browserSolverMod) {
      _browserSolverMod = await import('./browser_solver.js').catch(async () => {
        return await import('../browser_solver.js').catch(() => null);
      });
    }
    if (_browserSolverMod && _browserSolverMod.solveChallengeWithBrowser) {
      return await _browserSolverMod.solveChallengeWithBrowser(verifyUrl, ndusToken);
    }
  } catch (err) {
    console.warn('[VPS Browser Solver] Dynamic import skipped:', err.message);
  }
  return { success: false, error: 'Browser solver module unavailable' };
}

// Deterministic browserId fingerprint generator bound to account token
function getBrowserIdForToken(token) {
  if (!token) return 'b_anon_default_session_id';
  return 'b_' + crypto.createHash('md5').update(String(token).trim()).digest('hex');
}

// Proxy function permanently disabled (Direct Connection active to prevent IP hopping)
function getNextProxyAgent() {
  return null;
}

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

export function extractNdusValue(str) {
  if (!str) return '';
  const match = String(str).match(/ndus=([^;]+)/i);
  const raw = match ? match[1].trim() : String(str).split(';')[0].trim();
  // TeraBox ndus tokens starting with the same 12 characters belong to the SAME account.
  // Returning the 12-char account signature enforces true multi-account uniqueness.
  if (raw.length >= 12) {
    return raw.slice(0, 12);
  }
  return raw;
}

export function deduplicateNdusTokens(tokenList) {
  const seen = new Set();
  const result = [];
  for (const t of tokenList) {
    if (!t || typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    const accountSig = extractNdusValue(trimmed);
    if (accountSig && !seen.has(accountSig)) {
      seen.add(accountSig);
      result.push(trimmed);
    }
  }
  return result;
}

// Helper to dynamically resolve outbound server public IP
let cachedPublicIp = null;
export async function getPublicIp() {
  if (cachedPublicIp) return cachedPublicIp;
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data && data.ip) {
      cachedPublicIp = data.ip;
      return cachedPublicIp;
    }
  } catch (e) {}
  return process.env.VPS_PUBLIC_IP || 'Outbound VPS IP';
}

// ── MULTI-ACCOUNT POOL & COOLDOWN MANAGER ────────────────────────────────────
const ndusCooldowns = new Map();
let currentTokenIndex = 0;

// Helper to get configured TeraBox credentials from process.env
function getConfiguredCredentials() {
  const credentialPairs = [];
  const defaultEmail = process.env.TERABOX_EMAIL || process.env.TERABOX_USER;
  const defaultPass = process.env.TERABOX_PASSWORD || process.env.TERABOX_PASS;
  if (defaultEmail && defaultPass) {
    credentialPairs.push({ email: defaultEmail, password: defaultPass });
  }
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`TERABOX_USER_${i}`] || process.env[`TERABOX_EMAIL_${i}`];
    const pass = process.env[`TERABOX_PASSWORD_${i}`] || process.env[`TERABOX_PASS_${i}`];
    if (email && pass) {
      if (!credentialPairs.some(p => p.email === email)) {
        credentialPairs.push({ email, password: pass });
      }
    }
  }
  return credentialPairs;
}

// Helper to check if Free Account Only mode is enabled (via Vercel Env or MongoDB)
export async function isFreeAccountOnlyMode() {
  const envVal = process.env.USE_FREE_ACCOUNT_ONLY || process.env.FREE_MODE_ONLY;
  if (envVal !== undefined && envVal !== '') {
    const s = String(envVal).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'USE_FREE_ACCOUNT_ONLY' }) || await SystemConfig.findOne({ key: 'FREE_MODE_ONLY' });
    if (config && config.value) {
      const s = String(config.value).trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    }
  } catch (e) {}
  return false;
}

// Helper to get Free TeraBox account email and password credentials from DB or Env
export async function getFreeCredentials() {
  let email = process.env.TERABOX_FREE_EMAIL || process.env.TERABOX_FREE_USER;
  let password = process.env.TERABOX_FREE_PASSWORD || process.env.TERABOX_FREE_PASS;

  try {
    await connectToDatabase();
    if (!email) {
      const emailConfig = await SystemConfig.findOne({ key: 'TERABOX_FREE_EMAIL' }) || await SystemConfig.findOne({ key: 'TERABOX_FREE_USER' });
      if (emailConfig && emailConfig.value) email = emailConfig.value.trim();
    }
    if (!password) {
      const passConfig = await SystemConfig.findOne({ key: 'TERABOX_FREE_PASSWORD' }) || await SystemConfig.findOne({ key: 'TERABOX_FREE_PASS' });
      if (passConfig && passConfig.value) password = passConfig.value.trim();
    }
  } catch (e) {}

  if (email && password) {
    return { email: email.trim(), password: password.trim() };
  }
  return null;
}

// Helper to get Free TeraBox ndus token from DB, Env, or auto-login with Free credentials
export async function getFreeNdusToken(whost = 'https://www.1024terabox.com') {
  // 1. Check MongoDB SystemConfig for TERABOX_FREE_NDUS
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_FREE_NDUS' });
    if (config && config.value && config.value.trim()) {
      const token = config.value.trim();
      const cooldownUntil = ndusCooldowns.get(token) || 0;
      if (Date.now() >= cooldownUntil) {
        return token;
      } else {
        console.warn(`[NDUS Pool] Free NDUS token is currently on cooldown due to 400141 challenge.`);
      }
    }
  } catch (e) {}

  // 2. Check process.env for TERABOX_FREE_NDUS
  const freeEnv = process.env.TERABOX_FREE_NDUS || process.env.FREE_NDUS || process.env.NDUS_FREE;
  if (freeEnv && freeEnv.trim()) {
    const token = freeEnv.trim();
    const cooldownUntil = ndusCooldowns.get(token) || 0;
    if (Date.now() >= cooldownUntil) {
      return token;
    }
  }

  // 3. Auto-login using Free Account Email & Password credentials if token is missing or on cooldown
  const freeCreds = await getFreeCredentials();
  if (freeCreds) {
    console.log(`[NDUS Pool] Running auto-login for Free TeraBox account (${freeCreds.email})...`);
    try {
      const app = new TeraBoxApp('');
      app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box'];
      app.TERABOX_DOMAIN = tbDomains.some(d => whost.includes(d)) ? '1024terabox.com' : 'terabox.com';
      app.params.whost = whost;
      app.params.uhost = whost;

      const preLoginData = await app.passportPreLogin(freeCreds.email);
      const loginRes = await app.passportLogin(preLoginData, freeCreds.email, freeCreds.password);

      if (loginRes.code === 0 && loginRes.data && loginRes.data.ndus) {
        const fullCookies = loginRes.data.cookies || `ndus=${loginRes.data.ndus}`;
        console.log(`[NDUS Pool] Free Account auto-login SUCCESS for ${freeCreds.email}!`);
        try {
          await connectToDatabase();
          await SystemConfig.findOneAndUpdate(
            { key: 'TERABOX_FREE_NDUS' },
            { value: fullCookies, updatedAt: new Date() },
            { upsert: true }
          );
        } catch (e) {}
        return fullCookies;
      } else {
        console.error(`[NDUS Pool] Free Account auto-login failed for ${freeCreds.email}:`, JSON.stringify(loginRes));
      }
    } catch (err) {
      console.error(`[NDUS Pool] Free Account auto-login error:`, err.message);
    }
  }

  return '';
}

async function getAllNdusTokens(whost = 'https://www.1024terabox.com') {
  // Check if Free Account Only mode is triggered
  const freeModeActive = await isFreeAccountOnlyMode();
  if (freeModeActive) {
    const freeToken = await getFreeNdusToken(whost);
    if (freeToken) {
      console.log(`[NDUS Pool] FREE MODE ACTIVE (USE_FREE_ACCOUNT_ONLY=true). Using Free TeraBox Account token.`);
      return [freeToken];
    } else {
      console.warn(`[NDUS Pool] FREE MODE ACTIVE but TERABOX_FREE_NDUS / TERABOX_FREE_EMAIL is not set in Vercel Env or MongoDB.`);
    }
  }

  const tokens = [];
  
  // 1. Read active tokens from MongoDB config cache
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    if (config && config.value) {
      let parsed = [];
      try {
        if (config.value.startsWith('[')) parsed = JSON.parse(config.value);
        else if (config.value.includes('|||')) parsed = config.value.split('|||');
        else parsed = config.value.split(',');
      } catch (e) { parsed = [config.value]; }
      parsed.map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean).forEach(t => {
        if (!tokens.includes(t)) tokens.push(t);
      });
    }
  } catch (err) {
    console.error('[NDUS Cache] Failed to fetch multi-account from DB:', err.message);
  }

  // 2. Read from static Vercel Env variables (TERABOX_NDUS, TERABOX_NDUS_1, etc.)
  const envKeys = Object.keys(process.env).filter(k => /^TERABOX_NDUS/i.test(k) || /^NDUS/i.test(k) || /^NUDUS/i.test(k));
  for (const k of envKeys) {
    const val = process.env[k];
    if (val && typeof val === 'string') {
      val.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
        if (!tokens.includes(t)) tokens.push(t);
      });
    }
  }

  // 3. Auto-bootstrap: Trigger auto-login in background if token pool has fewer tokens than configured credentials
  const credentials = getConfiguredCredentials();
  if (credentials.length > 0 && tokens.length < credentials.length && whost) {
    console.log(`[NDUS Pool] Have ${tokens.length} token(s) but ${credentials.length} account credential(s) configured. Triggering background auto-login for missing account(s)...`);
    refreshNdusToken(whost).catch(err => console.error('[NDUS Pool] Background auto-login error:', err.message));
  }

  const deduped = deduplicateNdusTokens(tokens);
  const maxAllowed = credentials.length > 0 ? credentials.length : 10;

  if (deduped.length !== tokens.length || deduped.length > maxAllowed) {
    const trimmed = deduped.slice(0, maxAllowed);
    console.log(`[NDUS Pool] Cleaned duplicate/excess tokens from MongoDB pool. Now using ${trimmed.length} unique account token(s).`);
    try {
      connectToDatabase().then(() => {
        SystemConfig.findOneAndUpdate(
          { key: 'TERABOX_NDUS' },
          { value: JSON.stringify(trimmed), updatedAt: new Date() },
          { upsert: true }
        ).catch(() => {});
      });
    } catch (e) {}
    return trimmed;
  }

  return deduped;
}

// Function to get Today's primary ndus token from pool using IST Day-based Rotation
export async function getNdusTokenDetails(whost = 'https://www.1024terabox.com') {
  const tokens = await getAllNdusTokens(whost);
  if (tokens.length === 0) return { token: '', selectedIndex: 0, totalTokens: 0 };

  // IST Day-based rotation (Day 1 -> Account 1, Day 2 -> Account 2, etc.)
  const istDateStr = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
  const dayNum = new Date(istDateStr).getDate() || 1;
  const selectedIndex = (dayNum - 1) % tokens.length;
  const selectedToken = tokens[selectedIndex];

  console.log(`[NDUS Pool] 📅 Day ${dayNum} IST → Primary Account ${selectedIndex + 1} selected (Token ${selectedIndex + 1}/${tokens.length})`);
  return { token: selectedToken, selectedIndex, totalTokens: tokens.length };
}

// Function to get Alternate account token for per-link 400141 failover
export async function getAlternateNdusTokenDetails(whost = 'https://www.1024terabox.com', currentIndex = 0) {
  const tokens = await getAllNdusTokens(whost);
  if (tokens.length <= 1) return { token: '', selectedIndex: currentIndex, totalTokens: tokens.length };

  const altIndex = (currentIndex + 1) % tokens.length;
  const altToken = tokens[altIndex];

  console.log(`[NDUS Pool] 🔄 Per-Link Failover: Swapping from Account ${currentIndex + 1} to Alternate Account ${altIndex + 1} (Token ${altIndex + 1}/${tokens.length})`);
  return { token: altToken, selectedIndex: altIndex, totalTokens: tokens.length };
}

export async function getNdusToken(whost = 'https://www.1024terabox.com') {
  const details = await getNdusTokenDetails(whost);
  return details.token;
}

// Put token on cooldown (default: 20 minutes) when 400141 occurs
export function markTokenCooldown(token, durationMs = 20 * 60 * 1000) {
  if (!token) return;
  const cooldownUntil = Date.now() + durationMs;
  ndusCooldowns.set(token, cooldownUntil);
  console.warn(`[NDUS Pool] Marked token on cooldown for ${Math.ceil(durationMs / 60000)} min due to 400141 challenge.`);
}

// Remove bad token from MongoDB when 400141 occurs
export async function removeTokenFromDb(badToken) {
  if (!badToken) return;
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    if (config && config.value) {
      let tokens = [];
      try {
        if (config.value.startsWith('[')) tokens = JSON.parse(config.value);
        else if (config.value.includes('|||')) tokens = config.value.split('|||');
        else tokens = config.value.split(',');
      } catch (e) { tokens = [config.value]; }

      tokens = tokens.map(t => typeof t === 'string' ? t.trim() : '').filter(t => t && t !== badToken);
      await SystemConfig.findOneAndUpdate(
        { key: 'TERABOX_NDUS' },
        { value: JSON.stringify(tokens), updatedAt: new Date() },
        { upsert: true }
      );
      console.log(`[MongoDB Cache] Removed bad token from TERABOX_NDUS (${tokens.length} token(s) remaining in DB).`);
    }
  } catch (err) {
    console.error('[MongoDB Cache] Failed to remove bad token:', err.message);
  }
}

// Update primary working token in MongoDB
export async function updatePrimaryNdusInDb(workingToken) {
  if (!workingToken) return;
  try {
    await connectToDatabase();
    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
    let tokens = [];
    if (config && config.value) {
      try {
        if (config.value.startsWith('[')) tokens = JSON.parse(config.value);
        else if (config.value.includes('|||')) tokens = config.value.split('|||');
        else tokens = config.value.split(',');
      } catch (e) { tokens = [config.value]; }
    }
    tokens = tokens.map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean);
    const workAccountSig = extractNdusValue(workingToken);
    tokens = [workingToken, ...tokens.filter(t => extractNdusValue(t) !== workAccountSig)];
    tokens = deduplicateNdusTokens(tokens);
    await SystemConfig.findOneAndUpdate(
      { key: 'TERABOX_NDUS' },
      { value: JSON.stringify(tokens), updatedAt: new Date() },
      { upsert: true }
    );
    console.log('[MongoDB Cache] Promoted working token to top of TERABOX_NDUS pool.');
  } catch (err) {
    console.error('[MongoDB Cache] Failed to update working token:', err.message);
  }
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


// Helper to reset free 3 daily trials if a new day has started in Indian Standard Time (IST - Asia/Kolkata)
export async function checkAndResetDailyTrials(user) {
  if (!user) return user;
  const now = new Date();
  const lastReset = user.lastTrialReset ? new Date(user.lastTrialReset) : new Date(0);

  const nowIST = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
  const lastResetIST = lastReset.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });

  const isNewDay = nowIST !== lastResetIST;

  if (isNewDay) {
    console.log(`[Daily Reset] Resetting 3 free trials for ${user.email} (IST New Day: ${nowIST}). Previous remaining: ${user.freePremiumUsesRemaining}`);
    user.freePremiumUsesRemaining = 3;
    user.lastTrialReset = now;
    await user.save();
  }
  return user;
}

// ── TIER ROUTING ──────────────────────────────────────────────────────────────
// Checks whether a given API key belongs to an active, non-expired paid
// subscription. Returns { isPremium: true, userId: email } or { isPremium: false }.
// The master API_KEY (used by the website) is treated as FREE tier.
// Only verified Razorpay-activated ApiSubscription tokens are PAID tier.
async function checkPremiumEntitlement(apiKey, req) {
  const clientType = req && req.headers ? (req.headers['x-client-type'] || req.headers['x-client-source']) : '';
  const fromQuery = req && req.query ? req.query.from : '';
  
  // Android App and Telegram Bot client get full NDUS premium access
  if (clientType === 'android_app' || clientType === 'app' || fromQuery === 'bot' || fromQuery === 'app') {
    console.log('[Entitlement] Bot/App client detected. Granting full NDUS stream access.');
    return { isPremium: true, userId: 'bot_or_app_client', plan: 'unlimited_bot', userType: 'bot' };
  }

  if (!apiKey) {
    console.log('[Entitlement] No API Key provided');
    return { isPremium: false, reason: 'unauthenticated' };
  }

  // Master API key check (website access) - Unlimited NDUS access granted
  if (apiKey === process.env.API_KEY) {
    console.log('[Entitlement] Master API Key detected. Granting unlimited website NDUS access.');
    return { isPremium: true, userId: 'website_user', plan: 'unlimited_website', userType: 'website' };
  }

  try {
    await connectToDatabase();
    console.log('[Entitlement] Database connected. Parsing token...');

    // 1. Google Auth Stateless Session Token Check
    const decoded = verifySessionToken(apiKey);
    if (decoded && decoded.email) {
      const email = decoded.email.toLowerCase().trim();
      console.log(`[Entitlement] Decoded Google token: email=${email}, role=${decoded.role}`);
      
      let user = await User.findOne({ email });
      if (!user) {
        console.log(`[Entitlement] Google user not found in DB: ${email}`);
        return { isPremium: true, userId: email, plan: 'unlimited_google', userType: 'unlimited' };
      }

      // Check and reset daily 3 trials if a new day has started
      user = await checkAndResetDailyTrials(user);

      console.log(`[Entitlement] User match: premiumStatus=${user.premiumStatus}, usesRemaining=${user.freePremiumUsesRemaining}`);

      // All users get unlimited premium access
      return { isPremium: true, userId: email, plan: user.plan || 'unlimited', userType: 'premium' };
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
      { 
        $inc: { freePremiumUsesRemaining: -1 },
        $push: { trialHistory: { usedAt: new Date() } }
      },
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
const accountAutoLoginCooldowns = new Map(); // Account-level login cooldown lock: prevents infinite login loops

// Function to refresh ndus token using credentials.
// Single-flight: if a refresh is already in progress, all callers await the same promise.
export async function refreshNdusToken(whost, targetAccountIndex = undefined) {
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
      // Collect all configured TeraBox email/password credential pairs
      const credentialPairs = getConfiguredCredentials();
      if (credentialPairs.length === 0) {
        console.log('[NDUS Auto-Login] Missing credentials (TERABOX_EMAIL / TERABOX_PASSWORD) in env variables.');
        return null;
      }

      let pairsToLogin = credentialPairs;
      if (targetAccountIndex !== undefined && targetAccountIndex >= 0 && targetAccountIndex < credentialPairs.length) {
        pairsToLogin = [{ pair: credentialPairs[targetAccountIndex], index: targetAccountIndex }];
      } else {
        pairsToLogin = credentialPairs.map((pair, index) => ({ pair, index }));
      }

      let currentDbTokens = await getAllNdusTokens(whost);
      let newGeneratedToken = null;

      for (const item of pairsToLogin) {
        const pair = item.pair;
        const actualIdx = item.index;
        console.log(`[NDUS Auto-Login] Attempting passport login for Account ${actualIdx + 1} (${pair.email})...`);
        const app = new TeraBoxApp('');
        app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box'];
        app.TERABOX_DOMAIN = tbDomains.some(d => whost && whost.includes(d)) ? '1024terabox.com' : 'terabox.com';
        app.params.whost = whost || 'https://www.1024terabox.com';
        app.params.uhost = app.params.whost;

        try {
          const preLoginData = await app.passportPreLogin(pair.email);
          const loginRes = await app.passportLogin(preLoginData, pair.email, pair.password);

          if (loginRes.code === 0 && loginRes.data && loginRes.data.ndus) {
            const fullCookies = loginRes.data.cookies || `ndus=${loginRes.data.ndus}`;
            console.log(`[NDUS Auto-Login] Success for Account ${actualIdx + 1} (${pair.email})! New fresh token generated.`);
            newGeneratedToken = fullCookies;
            if (actualIdx < currentDbTokens.length) {
              currentDbTokens[actualIdx] = fullCookies;
            } else {
              currentDbTokens.push(fullCookies);
            }
          } else {
            console.error(`[NDUS Auto-Login] Failed for Account ${actualIdx + 1} (${pair.email}). Response:`, JSON.stringify(loginRes));
          }
        } catch (accountErr) {
          console.error(`[NDUS Auto-Login] Exception for Account ${actualIdx + 1} (${pair.email}):`, accountErr.message);
        }
      }

      if (currentDbTokens.length > 0) {
        try {
          const mergedTokens = deduplicateNdusTokens(currentDbTokens);
          await SystemConfig.findOneAndUpdate(
            { key: 'TERABOX_NDUS' },
            { value: JSON.stringify(mergedTokens), updatedAt: new Date() },
            { upsert: true }
          );
          await SystemConfig.findOneAndUpdate(
            { key: 'TERABOX_ACCOUNTS' },
            { value: JSON.stringify(mergedTokens), updatedAt: new Date() },
            { upsert: true }
          );
          console.log(`[NDUS Auto-Login] Updated MongoDB configuration cache with ${mergedTokens.length} active cookie token(s).`);
        } catch (dbErr) {
          console.error('[NDUS Auto-Login] Failed to save to MongoDB:', dbErr.message);
        }
        return newGeneratedToken || currentDbTokens[targetAccountIndex || 0];
      }

      return null;
    } catch (loginErr) {
      console.error('[NDUS Auto-Login] Exception occurred:', loginErr.message);
      return null;
    } finally {
      _ndusRefreshInFlight = null;
    }
  })();

  return _ndusRefreshInFlight;
}

// Follow TeraBox dlink redirect to get actual CDN URL (faster download)
async function resolveCdnUrl(dlink, headers) {
  if (!dlink || typeof dlink !== 'string') return dlink;
  try {
    // Attempt 1: Fetch with GET and redirect: 'manual' (HEAD is blocked by TeraBox)
    const response = await fetch(dlink, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
    
    // TeraBox returns 302 redirect to actual CDN URL
    if (response.status === 302 || response.status === 301 || response.status === 303 || response.status === 307) {
      const location = response.headers.get('location');
      if (location && location.startsWith('http')) {
        console.log('[CDN] Resolved redirect (GET):', location.substring(0, 80) + '...');
        return location;
      }
    }

    // Attempt 2: Undici request fallback without auto-following redirects
    try {
      const { request: uRequest } = await import('undici');
      const uRes = await uRequest(dlink, {
        method: 'GET',
        headers,
        maxRedirections: 0,
        signal: AbortSignal.timeout(4000),
      });
      if (uRes.statusCode === 302 || uRes.statusCode === 301 || uRes.statusCode === 303 || uRes.statusCode === 307) {
        const uLoc = uRes.headers.location || uRes.headers['location'];
        if (uLoc && typeof uLoc === 'string' && uLoc.startsWith('http')) {
          console.log('[CDN] Resolved redirect (undici):', uLoc.substring(0, 80) + '...');
          return uLoc;
        }
      }
    } catch (uErr) {
      // ignore
    }

    return dlink;
  } catch (e) {
    console.log('[CDN] Redirect resolve failed, using original dlink:', e.message);
    return dlink;
  }
}

const TB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Telegram alert disabled
async function sendTelegramTokenAlert() {
  return;
}

// Recover dlink via /share/download when /share/list omits it.
// TeraBox stopped returning dlink in share/list for many sessions; this signed
// endpoint still returns it for valid logged-in (ndus) sessions.
// Returns '' on any failure.
async function resolveDlinkViaShareDownload(whost, sign, timestamp, shareId, uk, fsId, cookie, jsToken = '', shortUrl = '') {
  try {
    const dlUrl = new URL(`${whost}/share/download`);
    const params = {
      app_id: '250528',
      web: '1',
      channel: 'dubian-wap',
      clienttype: '0',
      shareid: String(shareId),
      uk: String(uk),
      sign: sign || '',
      timestamp: String(timestamp || ''),
      fs_id: String(fsId),
      root: '1',
    };
    if (shortUrl) params.shorturl = '1' + String(shortUrl).replace(/^1/, '');
    if (jsToken) params.jsToken = jsToken;
    dlUrl.search = new URLSearchParams(params);
    const { request } = await import('undici');
    const proxyDispatcher = getNextProxyAgent();

    let res;
    try {
      res = await request(dlUrl, {
        method: 'GET',
        headers: {
          'User-Agent': TB_UA,
          'Referer': `${whost}/sharing/link?surl=`,
          'Cookie': cookie || `browserid=${Math.random().toString(36).substring(2)}`,
        },
        dispatcher: proxyDispatcher || undefined,
        signal: AbortSignal.timeout(5000),
      });
    } catch (proxyErr) {
      console.log(`[Parse] Proxy fetch failed (${proxyErr.message}), retrying direct connection...`);
      res = await request(dlUrl, {
        method: 'GET',
        headers: {
          'User-Agent': TB_UA,
          'Referer': `${whost}/sharing/link?surl=`,
          'Cookie': cookie || `browserid=${Math.random().toString(36).substring(2)}`,
        },
        signal: AbortSignal.timeout(5000),
      });
    }
    
    const j = await res.body.json();
    const resolvedDlink = (j && j.dlink) || (j && j.urls && j.urls[0] && (j.urls[0].url || j.urls[0].dlink)) || '';
    if (j && j.errno === 0 && resolvedDlink) {
      console.log('[Parse] dlink recovered via /share/download:', resolvedDlink.substring(0, 80));
      return resolvedDlink;
    }
    console.log(`[Parse] /share/download fallback failed: errno=${j && j.errno} errmsg=${j && j.errmsg}`);
    
    // Bubble up CAPTCHA verification required exception if triggered
    if (j && (j.errno === 400310 || String(j.errmsg || '').includes('verify_v2'))) {
      const vUrl = (j.data && (j.data.verify_url || j.data.verifyUrl)) || '';
      throw { isCaptchaChallenge: true, verifyUrl: vUrl };
    }
    
    return '';
  } catch (e) {
    if (e && e.isCaptchaChallenge) throw e; // Pass challenge up
    console.log('[Parse] /share/download fallback error:', e.message);
    return '';
  }
}

// Helper to recursively fetch all files inside a directory (folder) in a TeraBox share link
// Uses the TeraBoxApp's shortUrlList method with undici TLS connector to bypass Cloudflare
async function fetchFolderFiles(app, shortUrl, dirPath, shareId, uk, browserId, ndusToken, depth = 0) {
  if (depth > 5) {
    console.warn(`[Folder Fetch] Max depth reached at: ${dirPath}`);
    return [];
  }
  try {
    console.log(`[Folder Fetch] Listing dir (depth=${depth}): ${dirPath}`);
    const rawShortUrl = shortUrl.replace(/^1/, '');
    const j = await app.shortUrlList(rawShortUrl, dirPath);
    console.log(`[Folder Fetch] Response for ${dirPath}: errno=${j && j.errno}, count=${j && j.list && j.list.length}`);
    if (j && j.errno === 0 && Array.isArray(j.list)) {
      const normalizedDirPath = (dirPath || '').replace(/\/+$/, '');
      // Separate subdirectories (excluding self-referencing path) and files
      const dirs = j.list.filter(item => {
        if (Number(item.isdir) !== 1) return false;
        const itemPath = (item.path || '').replace(/\/+$/, '');
        return itemPath !== normalizedDirPath;
      });
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

  // ── TRANSPARENT VERCEL-TO-VPS PROXY FORWARDER ──
  // Keeps existing Android app users working without app updates while forcing static VPS IP for TeraBox requests
  if (process.env.VERCEL && process.env.FORWARD_TO_VPS === 'true') {
    try {
      const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const vpsEndpoint = process.env.VPS_API_URL || 'https://api.teraboxdownloader.co.in/parse';
      const targetUrl = `${vpsEndpoint}${queryString}`;
      
      console.log(`[Vercel Forwarder] Forwarding Android/Web request to VPS static IP: ${targetUrl}`);
      let vpsRes = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'x-api-key': req.headers['x-api-key'] || '',
          'x-user-tier': req.headers['x-user-tier'] || '',
          'x-client-type': req.headers['x-client-type'] || '',
          'user-agent': req.headers['user-agent'] || 'Mozilla/5.0'
        }
      });
      
      // Retry once if VPS returned 502 Bad Gateway due to momentary reload/restart
      if (vpsRes.status === 502 || vpsRes.status === 503 || vpsRes.status === 504) {
        console.warn(`[Vercel Forwarder] VPS returned status ${vpsRes.status}. Retrying VPS in 600ms...`);
        await new Promise(r => setTimeout(r, 600));
        vpsRes = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'x-api-key': req.headers['x-api-key'] || '',
            'x-user-tier': req.headers['x-user-tier'] || '',
            'x-client-type': req.headers['x-client-type'] || '',
            'user-agent': req.headers['user-agent'] || 'Mozilla/5.0'
          }
        }).catch(() => vpsRes);
      }

      if (vpsRes.status !== 502 && vpsRes.status !== 503 && vpsRes.status !== 504) {
        try {
          const data = await vpsRes.json();
          return res.status(vpsRes.status).json(data);
        } catch (e) {
          const text = await vpsRes.text();
          return res.status(vpsRes.status).send(text);
        }
      }
      console.warn(`[Vercel Forwarder] VPS returned server error status ${vpsRes.status}. Falling back to local Vercel handler...`);
    } catch (proxyErr) {
      console.error('[Vercel Forwarder] Proxy failed, falling back to local Vercel handler:', proxyErr.message);
    }
  }

  // Dynamic Base URL Resolution
  const requestHost = req.headers['x-forwarded-host'] || req.headers.host || 'teraapi-six.vercel.app';
  const requestProto = req.headers['x-forwarded-proto'] || (requestHost.includes('localhost') ? 'http' : 'https');
  const currentBaseUrl = (process.env.PUBLIC_API_URL || `${requestProto}://${requestHost}`).replace(/\/+$/, '');

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

      // Check and Reset daily quota (using IST Indian Standard Time)
      const now = new Date();
      const lastReset = new Date(subscription.lastReset);
      const nowIST = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
      const lastResetIST = lastReset.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
      const isNewDay = nowIST !== lastResetIST;

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
        throw new Error('Video resolution failed. Please verify the URL and try again.');
      }

      return res.status(200).json({
        list: [
          {
            name: `${yt.title || 'Media_Video'} (Video - MP4)`,
            size: yt.mp4Size ? formatBytes(Number(yt.mp4Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp4 || '',
          },
          {
            name: `${yt.title || 'Media_Audio'} (Audio - MP3)`,
            size: yt.mp3Size ? formatBytes(Number(yt.mp3Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp3 || '',
          }
        ]
      });
    }

    // 2. Secondary Media Downloader
    if (lowerUrl.includes('instagram.com')) {
      console.log(`Resolving Media URL: ${cleanUrl}...`);
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
        throw new Error('No media files found in this post');
      }

      let caption = (data && data.caption) || (first && first.caption) || '';
      if (caption.length > 60) {
        caption = caption.substring(0, 60).trim() + '...';
      }
      const igTitle = caption ? `${caption}.mp4` : `Media_Video_${Date.now().toString().slice(-4)}.mp4`;
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

    // 3. Short Video Downloader
    if (lowerUrl.includes('tiktok.com')) {
      const tt = await ttdl(cleanUrl);
      if (!tt.status) {
        throw new Error(tt.message || 'Video resolution failed');
      }
      const videoUrl = Array.isArray(tt.video) ? tt.video[0] : tt.video;
      if (!videoUrl) {
        throw new Error('No video found in this link');
      }
      return res.status(200).json({
        list: [{
          name: tt.title || 'Media_Video.mp4',
          size: 'Unknown',
          thumbnail: tt.thumbnail || '',
          dlink: videoUrl,
        }]
      });
    }

    // 4. Social Media Downloader
    if (lowerUrl.includes('facebook.com') || lowerUrl.includes('fb.watch') || lowerUrl.includes('fb.gg')) {
      console.log(`Resolving Media URL: ${cleanUrl}...`);
      let data;
      try {
        const apiRes = await fetch(`https://backend1.tioo.eu.org/fbdown?url=${encodeURIComponent(cleanUrl)}`);
        data = await apiRes.json();
      } catch (err) {
        data = await fbdown(cleanUrl);
      }

      const videoUrl = data.HD || data.Normal_video || data.url;
      if (!videoUrl) {
        throw new Error('No video found in this post');
      }

      let title = data.title || data.caption || 'Media_Video';
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
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox link." });
    }

    // Always strip the leading '1' from the shortUrl because the /share/list API expects the raw surl token
    const strippedShortUrl = shortUrl.replace(/^1/, '');

    const outboundIp = await getPublicIp();
    const serverModeLog = process.env.VERCEL ? `Vercel (${outboundIp})` : `VPS (${outboundIp})`;
    if (process.env.PROXY_URL) {
      const maskedProxy = process.env.PROXY_URL.replace(/:[^:@]+@/, ':****@');
      console.log(`[Webshare Proxy] 🌐 Active Webshare Proxy detected in Vercel Env: ${maskedProxy}`);
    }
    console.log(`[VPS Server] 🌐 Processing TeraBox API call via ${serverModeLog} for surl: ${strippedShortUrl}`);

    // ─── CACHE CHECK (Execute first to protect trials & prevent load) ───
    try {
      await connectToDatabase();
      const cachedRecord = await LinkCache.findOne({ shortUrl: strippedShortUrl });
      if (cachedRecord && cachedRecord.response) {
        const cacheAgeMs = cachedRecord.createdAt ? (Date.now() - new Date(cachedRecord.createdAt).getTime()) : 99999999;
        const cachedList = cachedRecord.response && cachedRecord.response.list ? cachedRecord.response.list : [];
        const shouldPurgeCache = req.query.nocache === 'true' || req.query.refresh === '1' || cachedList.some(item => {
          // Purge if dlink is missing, contains an error, or contains legacy download.php proxy fallback
          return !item.dlink || item.dlink.startsWith('ERROR') || item.dlink.includes('download.php');
        });

        if (shouldPurgeCache) {
          console.log(`[Cache Purge] Purging cached record with invalid/proxy dlink for surl: ${strippedShortUrl}`);
          await LinkCache.deleteOne({ shortUrl: strippedShortUrl });
        } else if (cacheAgeMs < 10 * 60 * 1000) {
          console.log(`[Cache Hit] Serving fresh cached response (${Math.round(cacheAgeMs/60000)}m old) for surl: ${strippedShortUrl}`);
          return res.status(200).json(cachedRecord.response);
        } else {
          console.log(`[Cache Expired] Purging stale cached response (${Math.round(cacheAgeMs/60000)}m old) for surl: ${strippedShortUrl}`);
          await LinkCache.deleteOne({ shortUrl: strippedShortUrl });
        }
      }
    } catch (cacheErr) {
      console.error('[Cache Read Error] Failed to read from cache:', cacheErr.message);
    }

    // ── ENTITLEMENT CHECK (Only execute if cache misses) ──────────────────────
    const entitlement = await checkPremiumEntitlement(apiKey, req);
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

    // ── ANDROID APP / TELEGRAM BOT CLIENT DETECTION (UNLIMITED PARSING) ──
    const isAppClient = (
      req.query.from === 'app' || 
      req.query.from === 'bot' || 
      req.query.source === 'app' || 
      req.query.source === 'bot' || 
      req.headers['x-client-type'] === 'android_app' || 
      req.headers['x-client-source'] === 'app'
    );

    if (isAppClient) {
      isPremium = true;
      entitlement.isPremium = true;
      entitlement.plan = 'unlimited_client';
      entitlement.userType = 'app_or_bot_user';
      console.log('[ROUTER] App/Bot client detected. Premium NDUS routing enabled without 3-link daily limit restrictions.');
    }

    // ── BLOCKED IF TRIALS EXHAUSTED OR PLAN EXPIRED (WEBSITE USERS ONLY) ──
    if (!isAppClient && !isPremium && (entitlement.reason === 'trials_exhausted' || entitlement.reason === 'premium_expired')) {
      const isExp = entitlement.reason === 'premium_expired';
      console.log(`[ROUTER] Blocking user ${entitlement.userId || 'unknown'} due to ${entitlement.reason}`);
      return res.status(403).json({
        success: false,
        code: isExp ? 'PREMIUM_EXPIRED' : 'DAILY_LIMIT_EXCEEDED',
        error: isExp 
          ? 'Your premium subscription has expired. Please renew your plan to continue.' 
          : 'Daily free limit reached (3/3 used). Please upgrade to Premium for unlimited downloads.',
        message: isExp 
          ? 'Your premium subscription has expired. Please renew your plan to continue.' 
          : 'Daily free limit reached (3/3 used). Please upgrade to Premium for unlimited downloads.'
      });
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
    let usedAnonymousFallback = false;
    let activeWorkingNdusToken = '';
    let browserId = getBrowserIdForToken('');

    if (isPremium) {
      // ── PREMIUM ROUTE ──
      console.log(`[ROUTER] user=${entitlement.userId || 'api'} feature=parse entitlement=paid`);
      console.log('[ROUTER] Using premium route (NDUS session pool)...');
      
      const poolTokens = await getAllNdusTokens(anonApp.params.whost);
      const todayAccountDetails = await getNdusTokenDetails(anonApp.params.whost);
      const startIndex = todayAccountDetails.selectedIndex;
      
      // Attempt all accounts in the pool sequentially before falling back to Anonymous
      for (let attempt = 0; attempt < Math.max(1, poolTokens.length); attempt++) {
        const curIndex = (startIndex + attempt) % Math.max(1, poolTokens.length);
        let curToken = poolTokens[curIndex] || todayAccountDetails.token;

        if (!curToken) {
          console.log(`[Premium] Account ${curIndex + 1}: No token found. Bootstrapping...`);
          curToken = await refreshNdusToken(anonApp.params.whost, curIndex) || '';
        }
        if (!curToken) continue;

        activeWorkingNdusToken = curToken;
        browserId = getBrowserIdForToken(curToken);
        console.log(`[NDUS Pool] 🔄 Attempt ${attempt + 1}/${poolTokens.length || 1}: Trying Account ${curIndex + 1}...`);

        let app = new TeraBoxApp(buildCookie(curToken, browserId));
        app.params.ua = anonApp.params.ua;
        app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
        app.params.whost = anonApp.params.whost;
        app.params.uhost = anonApp.params.uhost;
        premiumApp = app;

        try {
          let ndusData = await app.shortUrlList(strippedShortUrl);
          console.log(`[Premium] Account ${curIndex + 1} NDUS session response:`, JSON.stringify(ndusData));

          // Link expiry check BEFORE token refresh
          const isLinkExpired = ndusData && (
            ndusData.errno === 140 || ndusData.errno === -140 ||
            ndusData.errno === 116 || ndusData.errno === 117 ||
            ndusData.errno === 12  || ndusData.errno === 110 ||
            ndusData.errno === -110 || ndusData.errno === -4 || ndusData.errno === 4 ||
            ndusData.errno === 2130 || ndusData.errno === -2130 || ndusData.errno === 9 || ndusData.errno === -9 ||
            ndusData.errno === 105 || ndusData.errno === -6 ||
            String(ndusData.errmsg || '').toLowerCase().includes('delete') ||
            String(ndusData.errmsg || '').toLowerCase().includes('expire') ||
            String(ndusData.errmsg || '').toLowerCase().includes('not exist')
          );

          if (isLinkExpired) {
            console.log('[Premium] Link is expired or deleted. Skipping further account retries.');
            listData = ndusData;
            break;
          }

          if (ndusData && ndusData.errno === 400141) {
            const vUrl = (ndusData.data && (ndusData.data.verify_url || ndusData.data.verifyUrl)) || `https://www.1024terabox.com/sharing/link?surl=${strippedShortUrl}`;
            console.warn(`[Premium] 400141 challenge detected on Account ${curIndex + 1}. Marking on 20-min cooldown...`);
            markTokenCooldown(curToken, 20 * 60 * 1000);

            // Trigger background browser verification async
            console.log(`[Premium] Triggering background browser verification for Account ${curIndex + 1}...`);
            safeSolveChallengeWithBrowser(vUrl, curToken).catch(bErr => {
              console.warn('[Premium] Background browser solve exception:', bErr.message);
            });

            // Swapping immediately to next account in pool
            console.log(`[NDUS Pool] ⚡ 400141 challenge on Account ${curIndex + 1} -> Swapping immediately to next account...`);
            continue;
          }

          if (ndusData && (ndusData.errno === 4000020 || ndusData.errno === -6 || ndusData.errno === 105)) {
            console.warn(`[Premium] Account ${curIndex + 1} session token expired (errno ${ndusData.errno}). Triggering auto-login refresh...`);
            markTokenCooldown(curToken, 15 * 60 * 1000);
            refreshNdusToken(anonApp.params.whost, curIndex).catch(err => {
              console.error(`[NDUS Pool] Auto-login refresh failed for Account ${curIndex + 1}:`, err.message);
            });
            console.log(`[NDUS Pool] ⚡ Token expired on Account ${curIndex + 1} -> Swapping immediately to next account...`);
            continue;
          }

          if (ndusData && ndusData.errno === 0) {
            listData = ndusData;
            if (activeWorkingNdusToken) {
              updatePrimaryNdusInDb(activeWorkingNdusToken).catch(e => {});
            }
            break; // SUCCESS! Exit loop
          } else if (ndusData) {
            tokenExpiredDetected = true;
            console.warn(`[Premium] Account ${curIndex + 1} returned errno ${ndusData.errno}. Trying next account in pool...`);
          }
        } catch (e) {
          console.error(`[Premium] Account ${curIndex + 1} NDUS session failed (${e.message}). Swapping to next account in pool...`);
          // Continue loop to try next Premium Account in pool
        }
      }

      // Premium fallback: ONLY if ALL Premium NDUS accounts in pool failed, try anonymous (as absolute last resort)
      if (!listData || listData.errno !== 0) {
        console.log('[Premium] All NDUS accounts in pool failed or challenge-locked. Attempting anonymous fallback for paid user...');
        try {
          const anonFallback = new TeraBoxApp('');
          anonFallback.params.ua = anonApp.params.ua;
          anonFallback.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
          anonFallback.params.whost = anonApp.params.whost;
          anonFallback.params.uhost = anonApp.params.uhost;
          const anonRes = await anonFallback.shortUrlList(strippedShortUrl);
          console.log('[Premium] Anonymous fallback response:', JSON.stringify(anonRes));
          if (anonRes && anonRes.errno === 0) {
            listData = anonRes;
            usedAnonymousFallback = true;
          }
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
        usedAnonymousFallback = true;
      } catch (freeErr) {
        console.error('[Free] Anonymous TeraBox failed:', freeErr.message);
      }
    }

    tokenExpiredDetected = false;

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
            errno === 12 || errno === 110 || errno === -110 || errno === -4 || errno === 4 ||
            errmsg.includes('delete') || errmsg.includes('expire') || errmsg.includes('not exist')) {
          return res.status(404).json({
            success: false,
            code: 'SHARE_UNAVAILABLE',
            message: 'This shared link is expired or unavailable.'
          });
        }

        // ── TERABOX_VERIFICATION_REQUIRED: errno 400141 / need verify ──
        if (errno === 400141 || errmsg.includes('need verify') || errmsg.includes('verify_v2')) {
          const vUrl = (listData.data && (listData.data.verify_url || listData.data.verifyUrl)) || `https://www.1024terabox.com/sharing/link?surl=${strippedShortUrl}`;
          console.warn(`\n================================================================================`);
          console.warn(`⚠️ TERABOX VERIFICATION CHALLENGE REQUIRED (errno ${errno})`);
          console.warn(`🔗 Verification Link (Open & Solve in VPS Browser to Clear Challenge):`);
          console.warn(`👉 ${vUrl}`);
          console.warn(`================================================================================\n`);
          return res.status(503).json({
            success: false,
            code: 'TERABOX_VERIFICATION_REQUIRED',
            message: 'TeraBox captcha verification is required for this IP/Account. Open the link to solve.',
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

    // Only fetch NDUS token for PAID users if NDUS session succeeded — FREE users or Anonymous fallback must NEVER use blocked premium credentials
    // This gates streaming, dlink recovery, and HLS resolution for the file processing below.
    let ndusToken = (isPremium && !usedAnonymousFallback) ? (activeWorkingNdusToken || await getNdusToken()) : '';
    if (!isPremium) {
      console.log('[ROUTER] Free tier: ndusToken withheld. Streaming and premium dlink will be skipped.');
    }

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

    // Handle folder links and links with multiple files
    if (listData && Array.isArray(listData.list)) {
      const topDirs = listData.list.filter(f => Number(f.isdir) === 1);
      const isMultipleFiles = listData.list.length > 1 || topDirs.length > 0;

      if (isMultipleFiles) {
        // Check if user is VIP / Premium
        const isUserVip = (
          req.headers['x-user-tier'] === 'premium' ||
          req.headers['x-is-vip'] === 'true' ||
          req.query.is_vip === 'true' ||
          req.query.is_vip === '1' ||
          req.query.user_tier === 'premium' ||
          isAppClient ||
          (entitlement && entitlement.isPremium)
        );

        if (!isUserVip) {
          console.log(`[Parse] Link contains a folder/multiple files (${listData.list.length} items, ${topDirs.length} dirs). Rejecting free user request.`);
          return res.status(403).json({
            success: false,
            code: 'VIP_REQUIRED_FOR_FOLDERS',
            error: 'Folders contain multiple files. Downloading full folders is exclusive to VIP members.',
            message: 'Folders contain multiple files. Downloading full folders is exclusive to VIP members.'
          });
        }

        console.log(`[Parse] 🌟 VIP User detected! Processing folder/multi-file link (${listData.list.length} top items, ${topDirs.length} sub-dirs)...`);

        // If there are subdirectories, recursively expand them into individual files
        if (topDirs.length > 0) {
          const appToUse = premiumApp || new TeraBoxApp(`browserid=${browserId}`);
          appToUse.params.ua = anonApp.params.ua;
          appToUse.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
          appToUse.params.whost = anonApp.params.whost;
          appToUse.params.uhost = anonApp.params.uhost;

          const topFiles = listData.list.filter(f => Number(f.isdir) !== 1);
          const expandedFiles = await Promise.all(
            topDirs.map(dir => fetchFolderFiles(appToUse, strippedShortUrl, dir.path, listData.share_id || listData.shareid, listData.uk, browserId, activeWorkingNdusToken))
          );
          const allFolderFiles = topFiles.concat(...expandedFiles);

          if (allFolderFiles.length > 0) {
            console.log(`[Parse] Successfully expanded folder into ${allFolderFiles.length} individual files.`);
            listData.list = allFolderFiles;
          }
        }
      }
    }

    const isFolderExpanded = false;

    const formattedList = await Promise.all((listData.list || []).map(async (file) => {
      // ── PROTECTION 1: Adult content block (Bypassed) ──
      // Bypassed: Allow all content to stream and download without restrictions
      const isAdultRaw = file.is_adult;
      if (isAdultRaw === 1 || isAdultRaw === '1' || Number(isAdultRaw) === 1) {
        console.log(`[Parse] Adult content detected (is_adult=1) for file: ${file.server_filename}. Bypass active, allowing stream & download.`);
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

      const targetFsId = file.fs_id || file.fsid;

      // Recover missing dlink via the signed /share/download endpoint
      // (share/list no longer returns dlink for many sessions)
      // Only execute this recovery step if we have a premium ndusToken (since anonymous calls trigger verify_v2 captcha loop)
      let dlink = file.dlink || '';
      let verifyV2Url = '';

      if (!dlink && targetFsId && premiumApp) {
        try {
          console.log(`[Parse] Attempting premiumApp.download for fs_id: ${targetFsId}...`);
          const dlRes = await premiumApp.download([targetFsId]);
          if (dlRes && dlRes.errno === 0) {
            const rawDl = (dlRes.dlink && Array.isArray(dlRes.dlink) && dlRes.dlink[0] && dlRes.dlink[0].dlink) || (typeof dlRes.dlink === 'string' ? dlRes.dlink : '');
            if (rawDl) {
              dlink = rawDl;
              console.log(`[Parse] premiumApp.download succeeded for fs_id ${targetFsId}: ${dlink.substring(0, 80)}...`);
            }
          }
        } catch (dlErr) {
          console.log(`[Parse] premiumApp.download failed for fs_id ${targetFsId}:`, dlErr.message);
        }
      }

      if (!dlink && sign && timestamp && (listData.share_id || listData.shareid) && listData.uk && targetFsId) {
        const activeJsToken = (premiumApp && premiumApp.data && premiumApp.data.jsToken) || '';
        if (ndusToken) {
          const sessionCookie = buildCookie(ndusToken, browserId);
          
          // Fetch raw response to check for verify_url on failure
          const dlUrl = new URL(`${anonApp.params.whost}/share/download`);
          const dlParams = {
            app_id: '250528',
            web: '1',
            channel: 'dubian-wap',
            clienttype: '0',
            shareid: String(listData.share_id || listData.shareid),
            uk: String(listData.uk),
            fs_id: String(targetFsId),
            shorturl: '1' + strippedShortUrl,
            root: '1',
            sign: sign || '',
            timestamp: String(timestamp || ''),
          };
          if (activeJsToken) dlParams.jsToken = activeJsToken;
          dlUrl.search = new URLSearchParams(dlParams);
          
          try {
            const { request: uRequest } = await import('undici');
            const proxyDispatcher = getNextProxyAgent();

            let res;
            try {
              res = await uRequest(dlUrl, {
                method: 'GET',
                headers: {
                  'User-Agent': TB_UA,
                  'Referer': `${anonApp.params.whost}/sharing/link?surl=`,
                  'Cookie': sessionCookie,
                },
                dispatcher: proxyDispatcher || undefined,
                signal: AbortSignal.timeout(5000),
              });
            } catch (proxyErr) {
              console.log(`[Parse] Premium proxy fetch failed (${proxyErr.message}), retrying direct...`);
              res = await uRequest(dlUrl, {
                method: 'GET',
                headers: {
                  'User-Agent': TB_UA,
                  'Referer': `${anonApp.params.whost}/sharing/link?surl=`,
                  'Cookie': sessionCookie,
                },
                signal: AbortSignal.timeout(5000),
              });
            }

            const j = await res.body.json();
            const resolvedDlink = (j && j.dlink) || (j && j.urls && j.urls[0] && (j.urls[0].url || j.urls[0].dlink)) || '';
            if (j && j.errno === 0 && resolvedDlink) {
              dlink = resolvedDlink;
            } else {
              console.log(`[Parse] /share/download fallback failed: errno=${j && j.errno}`);
              if (j && (j.errno === 400310 || String(j.errmsg || '').includes('verify_v2'))) {
                verifyV2Url = (j.data && (j.data.verify_url || j.data.verifyUrl)) || '';
              }
            }
          } catch (e) {
            console.log('[Parse] /share/download fallback fetch error:', e.message);
          }
        }

        if (!dlink && !verifyV2Url) {
          console.log('[Parse] Premium dlink recovery failed or unavailable. Trying anonymous recovery...');
          try {
            dlink = await resolveDlinkViaShareDownload(
              anonApp.params.whost, sign, timestamp,
              listData.share_id || listData.shareid, listData.uk,
              targetFsId, `browserid=${browserId}`, activeJsToken, strippedShortUrl
            );
          } catch (anonErr) {
            console.log('[Parse] Anonymous dlink recovery error:', anonErr.message || anonErr);
          }
        }
        
        if (!dlink && ndusToken) {
          dlinkRecoveryFailed = true;
        }
      }

      // Resolve 302 redirect on dlink to produce direct final CDN URL
      if (dlink) {
        const sessionCookie = ndusToken ? buildCookie(ndusToken, browserId) : `browserid=${browserId}`;
        dlink = await resolveCdnUrl(dlink, {
          'User-Agent': TB_UA,
          'Referer': `${anonApp.params.whost}/`,
          'Cookie': sessionCookie
        });

        // Keep direct TeraBox CDN download link (d8.freeterabox.com) for 0-bandwidth direct downloads
        console.log(`[Parse] Direct TeraBox CDN dlink resolved: ${dlink.substring(0, 80)}...`);
      }

      // Direct TeraBox Download URL resolution (0-bandwidth client download)
      if (!dlink && sign && timestamp && (listData.share_id || listData.shareid) && listData.uk && targetFsId) {
        try {
          const shareId = listData.share_id || listData.shareid || '';
          const activeJsToken = (premiumApp && premiumApp.data && premiumApp.data.jsToken) || '';
          let rawDownloadUrl = `${anonApp.params.whost}/share/download?app_id=250528&web=1&channel=dubian-wap&clienttype=0&fs_id=${targetFsId}&shorturl=1${strippedShortUrl}&root=1&uk=${listData.uk}&shareid=${shareId}&sign=${sign}&timestamp=${timestamp}`;
          if (activeJsToken) {
            rawDownloadUrl += `&jsToken=${encodeURIComponent(activeJsToken)}`;
          }
          const sessionCookie = ndusToken ? buildCookie(ndusToken, browserId) : `browserid=${browserId}`;

          // Attempt 302 redirect resolution first to extract direct CDN download URL
          const directLocation = await resolveCdnUrl(rawDownloadUrl, {
            'User-Agent': TB_UA,
            'Referer': `${anonApp.params.whost}/sharing/link?surl=`,
            'Cookie': sessionCookie
          });

          if (directLocation && directLocation !== rawDownloadUrl && directLocation.startsWith('http') && !directLocation.includes('/share/download')) {
            dlink = directLocation;
            console.log(`[Parse] Direct TeraBox CDN dlink resolved via 302 redirect: ${dlink.substring(0, 80)}...`);
          } else {
            // Use direct raw TeraBox download endpoint (Android client will follow 302 redirect directly, consuming 0 Vercel bandwidth)
            dlink = rawDownloadUrl;
            console.log(`[Parse] Direct TeraBox raw download URL assigned: ${dlink.substring(0, 80)}...`);
          }
        } catch (fallbackErr) {
          console.error('[Parse] Direct TeraBox dlink assignment failed:', fallbackErr.message);
        }
      }

      // CAPTCHA verification required block removed to prevent loops in India

      // Extract effective sign and timestamp from file.dlink or listData for reliable M3U8 resolution
      let effectiveSign = sign || listData.sign || '';
      let effectiveTimestamp = timestamp || listData.timestamp || listData.server_time || '';
      const rawFileDlink = file.dlink || '';
      if (rawFileDlink) {
        const signMatch = rawFileDlink.match(/[?&]sign=([^&]+)/);
        if (signMatch && !effectiveSign) effectiveSign = decodeURIComponent(signMatch[1]);
        const tsMatch = rawFileDlink.match(/[?&](?:dstime|timestamp)=([^&]+)/);
        if (tsMatch && !effectiveTimestamp) effectiveTimestamp = decodeURIComponent(tsMatch[1]);
      }

      // Resolve TeraBox Native M3U8 HLS streaming playlist for 0-bandwidth instant video streaming
      let m3u8StreamUrl = '';
      if (isVideo && effectiveSign && effectiveTimestamp && (listData.share_id || listData.shareid) && listData.uk && targetFsId) {
        try {
          const shareId = String(listData.share_id || listData.shareid || '');
          const sessionCookie = ndusToken ? buildCookie(ndusToken, browserId) : `browserid=${browserId}`;
          const { request: uRequest } = await import('undici');
          const proxyDispatcher = getNextProxyAgent();

          const streamTypes = ['M3U8_AUTO_1080', 'M3U8_AUTO_720', 'M3U8_AUTO_480', 'M3U8_AUTO_360', 'M3U8_AUTO_210', 'M3U8_AUTO'];

          for (const sType of streamTypes) {
            const streamApiUrl = `${anonApp.params.whost}/share/streaming?app_id=250528&web=1&channel=dubian-wap&clienttype=0&is_vip=1&vip=1&uk=${listData.uk}&shareid=${shareId}&sign=${effectiveSign}&timestamp=${effectiveTimestamp}&fid=${targetFsId}&type=${sType}`;

            let m3u8Res = null;
            try {
              m3u8Res = await uRequest(streamApiUrl, {
                method: 'GET',
                headers: {
                  'User-Agent': TB_UA,
                  'Referer': `${anonApp.params.whost}/`,
                  'Cookie': sessionCookie
                },
                dispatcher: proxyDispatcher || undefined,
                signal: AbortSignal.timeout(4000)
              });
            } catch (pErr) {
              try {
                m3u8Res = await uRequest(streamApiUrl, {
                  method: 'GET',
                  headers: {
                    'User-Agent': TB_UA,
                    'Referer': `${anonApp.params.whost}/`,
                    'Cookie': sessionCookie
                  },
                  signal: AbortSignal.timeout(4000)
                });
              } catch {}
            }

            if (m3u8Res && m3u8Res.statusCode === 200) {
              const m3u8Text = await m3u8Res.body.text();
              if (m3u8Text && (m3u8Text.includes('#EXTM3U8') || m3u8Text.includes('#EXTM3U'))) {
                m3u8StreamUrl = `data:application/x-mpegURL;base64,${Buffer.from(m3u8Text).toString('base64')}`;
                console.log(`[Parse] TeraBox Native M3U8 HLS stream resolved (${sType}, ${m3u8Text.length} bytes)`);
                break;
              }
            }
          }
        } catch (m3u8Err) {
          console.warn('[Parse] TeraBox M3U8 HLS resolution failed, falling back to direct CDN:', m3u8Err.message);
        }
      }

      // Direct 0-bandwidth streaming & download configuration
      // dlink: raw direct TeraBox CDN link for 0-bandwidth high-speed direct file downloads
      // stream_url: TeraBox Native M3U8 HLS data URI if available, or direct CDN URL for instant progressive playback
      const directCdnUrl = dlink || '';
      const fallbackStreamUrl = directCdnUrl;

      const finalStreamUrl = isVideo ? (m3u8StreamUrl || fallbackStreamUrl) : '';
      if (isVideo) {
        if (m3u8StreamUrl) {
          console.log(`[Parse] 🎥 Stream Mode: Native M3U8 HLS Data URI Active`);
        } else {
          console.log(`[Parse] 🎥 Stream Mode: Direct CDN Instant Stream Active -> ${fallbackStreamUrl.substring(0, 100)}...`);
        }
      }

      return {
        name: file.server_filename || 'video.mp4',
        size: file.size ? formatBytes(Number(file.size)) : 'Unknown',
        thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
        dlink: directCdnUrl,
        download_url: directCdnUrl,
        stream_url: finalStreamUrl,
        status: !directCdnUrl ? 'unavailable' : 'ok',
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
    // Consume 1 trial ONLY if link resolution was 100% successful with valid download/stream content.
    // If the link had an error, expired, or failed to resolve, NO quota is deducted.
    if (isPremium && entitlement.userType === 'free_trial') {
      const hasResolvedSuccess = formattedList.some(
        item => item.status === 'ok' && (item.dlink || (item.stream_url && !item.stream_url.startsWith('ERROR')))
      );
      if (hasResolvedSuccess) {
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
      } else {
        console.log(`[Trial] No valid content resolved for ${entitlement.userId}. Trial was NOT consumed.`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Save payload to MongoDB Cache ONLY for true Premium NDUS responses (Skip caching for Anonymous Fallback responses)
    const hasValidCdn = formattedList.some(
      item => item.status === 'ok' && item.dlink && 
              item.error_code !== 'CONTENT_RESTRICTED' && 
              item.error_code !== 'TERABOX_VERIFICATION_REQUIRED' &&
              item.error_code !== 'TERABOX_RATE_LIMITED' &&
              item.error_code !== 'SHARE_UNAVAILABLE'
    );
    if (hasValidCdn && !usedAnonymousFallback) {
      try {
        await LinkCache.findOneAndUpdate(
          { shortUrl: strippedShortUrl },
          { response: payload, createdAt: new Date() },
          { upsert: true, returnDocument: 'after' }
        );
        console.log(`[Cache Save] Successfully cached Premium NDUS response for surl: ${strippedShortUrl}`);
      } catch (cacheErr) {
        console.error('[Cache Save Error] Failed to write response to cache:', cacheErr.message);
      }
    } else if (usedAnonymousFallback) {
      console.log(`[Cache Skip] Anonymous fallback used for surl: ${strippedShortUrl}. Skipped MongoDB caching so future requests can get fresh Premium NDUS resolution once cooldown ends.`);
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
