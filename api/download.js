import { Readable } from 'stream';
import { connectToDatabase, SystemConfig, ApiSubscription, User } from '../db.js';
import { verifySessionToken } from './auth/me.js';
import { consumeFreeTrial, getNdusToken, markTokenCooldown, setupWebshareProxy } from './parse.js';

setupWebshareProxy();

export const config = { maxDuration: 60 };

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

  const { url, filename, b64, cookie } = req.query;
  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  let decodedUrl = url;
  if (b64 === '1' || b64 === 'true') {
    try {
      decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
    } catch (e) {
      console.error('[download] Base64 decode failed:', e.message);
    }
  }

  let parsed;
  try {
    parsed = new URL(decodedUrl);
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
    const tbDomains = ['1024tera','1024terabox','terasharefile','terashare','terasharelink','nephobox','teraboxapp','tibbox','tibibox','freeterabox','teraboxlink','mirrobox','4funbox','terabox.fun','momerybox','terabox.app','terabox.ap','dubox','terabox.best','teraboxshare','terafileshare','1024box'];
    if (tbDomains.some(d => parsed.hostname.includes(d))) {
      referer = 'https://www.1024terabox.com/';
    }
  } catch {}

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': referer,
  };
  const sessionCookie = cookie || ndusToken || "";
  if (sessionCookie) headers['Cookie'] = sessionCookie.includes('=') ? sessionCookie : `ndus=${sessionCookie}`;

  const range = req.headers['range'];
  if (range) headers['Range'] = range;

  let upstream;
  try {
    // Perform manual redirect handling to prevent fetch from stripping cross-domain Cookie headers
    upstream = await fetch(decodedUrl, { headers, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get('location');
      if (location) {
        console.log(`[Vercel Download Proxy] Following redirect to CDN with session cookie preserved: ${location.substring(0, 80)}...`);
        upstream = await fetch(location, { headers, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
          const secondLoc = upstream.headers.get('location');
          if (secondLoc) {
            upstream = await fetch(secondLoc, { headers, redirect: 'follow' });
          }
        }
      }
    }
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach upstream: ' + e.message });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).json({ error: `Upstream returned HTTP ${upstream.status}` });
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
