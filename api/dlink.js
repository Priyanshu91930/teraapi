import { TeraBoxApp } from '../api.js';
import { connectToDatabase, SystemConfig } from '../db.js';

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
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { fs_id, share_id, uk } = req.query;
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

    // Fetch sign and timestamp using app's internal file info method
    let sign = '';
    let timestamp = '';
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

    if (!sign || !timestamp) {
      return res.status(500).json({ error: 'Could not get sign/timestamp for share' });
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
      return res.status(200).json({ dlink: dlData.dlink });
    }

    return res.status(200).json({ dlink: '', error: `errno=${dlData && dlData.errno} errmsg=${dlData && dlData.errmsg}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
