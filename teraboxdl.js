import crypto from 'node:crypto';

const BASE_URL = process.env.TERABOXDL_API_URL || 'https://api.teraboxdl.site';
const API_PATH = '/v1/api';
const TIMEOUT_MS = 30000;

export function signRequest({ apiSecret, method = 'POST', path = API_PATH, timestamp, body = '' }) {
  const payload = `${method}${path}${timestamp}${body}`;
  return crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('hex');
}

export function formatTeraboxdlList(data) {
  const files = (data && data.list) || [];
  return {
    list: files.map((f) => ({
      name: f.server_filename || 'video.mp4',
      size: f.formatted_size || (f.size ? formatBytes(Number(f.size)) : 'Unknown'),
      thumbnail: f.thumbs?.url3 || f.thumbs?.url1 || '',
      dlink: f.direct_link || f.dlink || '',
    })),
    downloadHeaders: {},
    source: 'teraboxdl',
  };
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export async function extractWithKey({ apiKey, apiSecret, url, dirPath = '', page = 1 }) {
  const body = JSON.stringify({
    url,
    ...(dirPath ? { dir_path: dirPath } : {}),
    page,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signRequest({ apiSecret, timestamp, body });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${API_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-API-Key': apiKey,
        'X-Timestamp': String(timestamp),
        'X-Signature': signature,
      },
      body,
      signal: controller.signal,
    });

    if (res.status !== 200) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`teraboxdl API HTTP ${res.status}: ${errText.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    if (json.errno !== 0) {
      const err = new Error(`teraboxdl API errno ${json.errno}`);
      err.status = 400;
      err.data = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}
