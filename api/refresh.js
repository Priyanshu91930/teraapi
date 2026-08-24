import { connectToDatabase, SystemConfig } from '../db.js';
import { refreshNdusToken } from './parse.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!process.env.API_KEY || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: "Access denied. Invalid or missing API key." });
  }

  try {
    await connectToDatabase();
    console.log('[Refresh] Manual ndus token refresh triggered via /refresh endpoint');

    const whost = req.query.whost || 'https://www.1024tera.com';
    const newToken = await refreshNdusToken(whost);

    if (!newToken) {
      return res.status(502).json({
        success: false,
        error: "Auto-login failed. Check Vercel function logs for details."
      });
    }

    const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });

    return res.status(200).json({
      success: true,
      savedToDb: !!config,
      dbUpdatedAt: config ? config.updatedAt : null,
      token_preview: `${newToken.substring(0, 6)}...${newToken.substring(newToken.length - 4)}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
