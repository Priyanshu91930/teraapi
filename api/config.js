import { connectToDatabase, SystemConfig } from '../db.js';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Check: Validate Admin API Key
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const secureKey = process.env.API_KEY;

  if (!apiKey || apiKey !== secureKey) {
    return res.status(401).json({ error: "Unauthorized access. Invalid or missing API key." });
  }

  try {
    await connectToDatabase();

    if (req.method === 'GET') {
      // Retrieve current cached token
      const config = await SystemConfig.findOne({ key: 'TERABOX_NDUS' });
      const currentToken = config ? config.value : "";

      // Obscured version for casual/manual checks
      const obscuredToken = currentToken
        ? `${currentToken.substring(0, 5)}...${currentToken.substring(currentToken.length - 5)}`
        : "None (falling back to Vercel env)";

      // Full token ONLY revealed to authenticated callers (admin API key is
      // required above) — consumed by the Hostinger download proxy so it can
      // always send the same fresh session cookie as the Vercel API.
      const reveal = req.query.reveal === '1';

      return res.status(200).json({
        status: "success",
        cached_ndus: obscuredToken,
        ndus_full: reveal ? currentToken : "",
        updatedAt: config ? config.updatedAt : null
      });
    }

    if (req.method === 'POST') {
      const { ndus } = req.body || {};
      if (!ndus) {
        return res.status(400).json({ error: "Missing 'ndus' parameter in request body." });
      }

      // Update the cache in MongoDB
      const updatedConfig = await SystemConfig.findOneAndUpdate(
        { key: 'TERABOX_NDUS' },
        { value: ndus, updatedAt: new Date() },
        { upsert: true, new: true }
      );

      console.log('[Config API] Updated TERABOX_NDUS successfully in MongoDB config.');
      return res.status(200).json({ 
        status: "success", 
        message: "TERABOX_NDUS updated successfully in database cache.",
        updatedAt: updatedConfig.updatedAt
      });
    }

    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
