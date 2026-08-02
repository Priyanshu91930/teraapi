import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.log('[DB] Warning: MONGODB_URI environment variable is missing.');
}

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export async function connectToDatabase() {
  if (!MONGODB_URI) return null;
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongooseInstance) => {
      console.log('[DB] Connected to MongoDB.');
      return mongooseInstance;
    });
  }
  
  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

// Define the Stats Schema
const StatsSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: Number, default: 0 },
});

export const Stat = mongoose.models.Stat || mongoose.model('Stat', StatsSchema);

// Define User Schema to track unique users (by IP hash)
const UserSchema = new mongoose.Schema({
  ipHash: { type: String, unique: true, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const UniqueUser = mongoose.models.UniqueUser || mongoose.model('UniqueUser', UserSchema);

// Helper to increment stats
export async function incrementStat(key, amount = 1) {
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    await Stat.findOneAndUpdate(
      { key },
      { $inc: { value: amount } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`[DB] Failed to increment stat ${key}:`, err.message);
  }
}

// Helper to track page views (which is parsed links) and unique users
export async function recordPageView(ipAddress) {
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    
    // Increment total views counter
    await incrementStat('views', 1);

    // Hash the IP to track unique users
    if (ipAddress) {
      const crypto = await import('node:crypto');
      const ipHash = crypto.createHash('md5').update(ipAddress).digest('hex');
      
      const userExists = await UniqueUser.exists({ ipHash });
      if (!userExists) {
        await UniqueUser.create({ ipHash });
        await incrementStat('users', 1);
      }
    }
  } catch (err) {
    console.error('[DB] Failed to record page view:', err.message);
  }
}
