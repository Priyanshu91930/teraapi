import { connectToDatabase, UserHistory } from '../db.js';

export default async function historyHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    await connectToDatabase();

    // 1. POST: Add / Save item to user's MongoDB history
    if (req.method === 'POST') {
      const { email, name, size, thumbnail, url } = req.body;
      if (!email || !url) {
        return res.status(400).json({ error: 'email and url are required' });
      }

      const cleanEmail = email.trim().toLowerCase();

      // Upsert: If user already searched this URL, update timestamp and name/thumbnail
      const existing = await UserHistory.findOne({ email: cleanEmail, url: url });
      if (existing) {
        existing.name = name || existing.name;
        existing.size = size || existing.size;
        existing.thumbnail = thumbnail || existing.thumbnail;
        existing.createdAt = new Date();
        await existing.save();
        return res.status(200).json({ success: true, item: existing });
      }

      // Create new history entry (Note: dlink is intentionally omitted for security)
      const newItem = await UserHistory.create({
        email: cleanEmail,
        name: name || 'TeraBox File',
        size: size || 'Unknown',
        thumbnail: thumbnail || '',
        url: url,
        createdAt: new Date(),
      });

      // Keep only top 50 history entries per user to prevent DB bloating
      const count = await UserHistory.countDocuments({ email: cleanEmail });
      if (count > 50) {
        const oldest = await UserHistory.find({ email: cleanEmail })
          .sort({ createdAt: 1 })
          .limit(count - 50);
        const idsToRemove = oldest.map((doc) => doc._id);
        await UserHistory.deleteMany({ _id: { $in: idsToRemove } });
      }

      return res.status(200).json({ success: true, item: newItem });
    }

    // 2. GET: Fetch user's MongoDB history
    if (req.method === 'GET') {
      const email = req.query.email || req.body?.email;
      if (!email) {
        return res.status(400).json({ error: 'email query parameter is required' });
      }

      const cleanEmail = email.trim().toLowerCase();
      const list = await UserHistory.find({ email: cleanEmail })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      const formatted = list.map((item) => ({
        id: item._id.toString(),
        name: item.name,
        size: item.size,
        thumbnail: item.thumbnail,
        url: item.url,
        downloadedAt: item.createdAt,
      }));

      return res.status(200).json({ success: true, history: formatted });
    }

    // 3. DELETE: Remove single item or clear all history
    if (req.method === 'DELETE') {
      const email = req.query.email || req.body?.email;
      const id = req.query.id || req.body?.id;
      const clearAll = req.query.clearAll || req.body?.clearAll;

      if (!email) {
        return res.status(400).json({ error: 'email is required' });
      }

      const cleanEmail = email.trim().toLowerCase();

      if (clearAll === 'true' || clearAll === true) {
        await UserHistory.deleteMany({ email: cleanEmail });
        return res.status(200).json({ success: true, message: 'History cleared' });
      }

      if (id) {
        await UserHistory.deleteOne({ _id: id, email: cleanEmail });
        return res.status(200).json({ success: true, message: 'Item deleted' });
      }

      return res.status(400).json({ error: 'id or clearAll parameter is required' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[History API Error]:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
