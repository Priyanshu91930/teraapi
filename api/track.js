import { incrementStat } from '../db.js';

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Check: Validate API Key
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const expectedKey = process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz';
  if (apiKey !== expectedKey) {
    return res.status(403).json({ error: "Access denied. Invalid or missing API key." });
  }

  const { type } = req.query;

  if (type === 'download' || type === 'downloads') {
    await incrementStat('downloads', 1);
    return res.status(200).json({ success: true, message: 'Download tracked' });
  }
  
  if (type === 'stream' || type === 'streams') {
    await incrementStat('streams', 1);
    return res.status(200).json({ success: true, message: 'Stream tracked' });
  }

  return res.status(400).json({ error: 'Invalid tracking type' });
}
