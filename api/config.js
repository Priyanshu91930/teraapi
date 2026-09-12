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

      const freeModeConfig = await SystemConfig.findOne({ key: 'USE_FREE_ACCOUNT_ONLY' });
      const freeNdusConfig = await SystemConfig.findOne({ key: 'TERABOX_FREE_NDUS' });
      const envFreeMode = process.env.USE_FREE_ACCOUNT_ONLY || process.env.FREE_MODE_ONLY;
      const freeModeActive = (envFreeMode === 'true' || envFreeMode === '1') || (freeModeConfig && (freeModeConfig.value === 'true' || freeModeConfig.value === '1'));

      // Obscured version for casual/manual checks
      const obscuredToken = currentToken
        ? `${currentToken.substring(0, 5)}...${currentToken.substring(currentToken.length - 5)}`
        : "None (falling back to Vercel env)";

      const reveal = req.query.reveal === '1';

      return res.status(200).json({
        status: "success",
        use_free_account_only: freeModeActive,
        free_ndus_configured: !!(freeNdusConfig?.value || process.env.TERABOX_FREE_NDUS),
        cached_ndus: obscuredToken,
        ndus_full: reveal ? currentToken : "",
        updatedAt: config ? config.updatedAt : null
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { ndus, free_ndus, free_email, free_password, use_free_account_only, action } = body;

      // Handle updating Free Mode toggle
      if (use_free_account_only !== undefined) {
        await SystemConfig.findOneAndUpdate(
          { key: 'USE_FREE_ACCOUNT_ONLY' },
          { value: String(use_free_account_only), updatedAt: new Date() },
          { upsert: true, new: true }
        );
        console.log(`[Config API] USE_FREE_ACCOUNT_ONLY set to ${use_free_account_only} in MongoDB.`);
      }

      // Handle updating Free Account credentials
      if (free_email !== undefined) {
        await SystemConfig.findOneAndUpdate(
          { key: 'TERABOX_FREE_EMAIL' },
          { value: String(free_email).trim(), updatedAt: new Date() },
          { upsert: true, new: true }
        );
        console.log('[Config API] TERABOX_FREE_EMAIL updated in MongoDB.');
      }

      if (free_password !== undefined) {
        await SystemConfig.findOneAndUpdate(
          { key: 'TERABOX_FREE_PASSWORD' },
          { value: String(free_password).trim(), updatedAt: new Date() },
          { upsert: true, new: true }
        );
        console.log('[Config API] TERABOX_FREE_PASSWORD updated in MongoDB.');
      }

      // Handle updating Free Account NDUS token
      if (free_ndus !== undefined) {
        await SystemConfig.findOneAndUpdate(
          { key: 'TERABOX_FREE_NDUS' },
          { value: String(free_ndus).trim(), updatedAt: new Date() },
          { upsert: true, new: true }
        );
        console.log('[Config API] TERABOX_FREE_NDUS updated successfully in MongoDB.');
      }

      // Allow clearing the token via action=clear or ndus='' (empty string)
      if (action === 'clear' || ndus === '') {
        await SystemConfig.deleteOne({ key: 'TERABOX_NDUS' });
        console.log('[Config API] TERABOX_NDUS cleared from MongoDB.');
        return res.status(200).json({
          status: 'success',
          message: 'TERABOX_NDUS token cleared.'
        });
      }

      if (ndus) {
        // Update the cache in MongoDB
        const updatedConfig = await SystemConfig.findOneAndUpdate(
          { key: 'TERABOX_NDUS' },
          { value: ndus, updatedAt: new Date() },
          { upsert: true, new: true }
        );

        console.log('[Config API] Updated TERABOX_NDUS successfully in MongoDB config.');
      }

      return res.status(200).json({ 
        status: 'success', 
        message: 'System configuration updated successfully in database cache.'
      });
    }

    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
