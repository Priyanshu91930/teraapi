import { connectToDatabase, Stat } from '../db.js';

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Check: Validate API Key
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const expectedKey = process.env.API_KEY;
  if (apiKey !== expectedKey) {
    return res.status(403).json({ error: "Access denied. Invalid or missing API key." });
  }

  try {
    await connectToDatabase();
    
    // Fetch stats from MongoDB
    const statsList = await Stat.find({});
    
    // Base starter values
    const baseStats = {
      downloads: 0,
      views: 0,
      streams: 0,
      users: 0
    };

    // Add DB values to base values
    statsList.forEach(stat => {
      if (baseStats[stat.key] !== undefined) {
        baseStats[stat.key] += stat.value;
      }
    });

    return res.status(200).json(baseStats);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to fetch statistics' });
  }
}
