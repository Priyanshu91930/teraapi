import { Readable } from 'stream';
import { connectToDatabase, SystemConfig } from '../db.js';

export const config = { maxDuration: 60 };

// Token lookup order: MongoDB cache first (auto-login refreshes this in
// realtime), then Vercel env as bootstrap/fallback.
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
  const expectedKey = process.env.API_KEY;
  if (apiKey !== expectedKey) {
    return res.status(403).json({ error: "Access denied. Invalid or missing API key." });
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
    if (u.hostname.includes('1024tera') || u.hostname.includes('terasharefile') || u.hostname.includes('teraboxlink')) {
      referer = 'https://www.1024terabox.com/';
    }
  } catch {}
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': referer,
  };
  if (ndusToken) headers['Cookie'] = `ndus=${ndusToken}`;

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
