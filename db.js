import { MongoClient } from 'mongodb';
let client = null;
let db = null;

const DB_NAME = process.env.MONGODB_DB || 'teraboxdl';
const COLLECTION = process.env.MONGODB_COLLECTION || 'api_keys';

export async function getDb() {
  if (db) return db;
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI env variable is not set');
  }
  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log('[DB] Connected to MongoDB');
  return db;
}

export function getKeysCollection() {
  return db.collection(COLLECTION);
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export const API_LIMIT_PER_MONTH = 100;

export function currentMonthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export async function getNextApiKey(excludeIds = []) {
  const col = getKeysCollection();
  const month = currentMonthKey();
  const cursor = col.find({ enabled: true }).sort({ lastUsedAt: 1 }).limit(50);
  let best = null;
  for await (const doc of cursor) {
    if (excludeIds.includes(doc._id.toString())) continue;
    const used = (doc.usage && doc.usage[month]) || 0;
    if (used >= API_LIMIT_PER_MONTH) continue;
    if (!best || (doc.usage && doc.usage[month] || 0) < ((best.usage && best.usage[month]) || 0)) {
      best = doc;
    }
    if (best && best.usage && (best.usage[month] || 0) === 0) break;
  }
  return best;
}

export async function incrementKeyUsage(keyDoc) {
  const col = getKeysCollection();
  const month = currentMonthKey();
  await col.updateOne(
    { _id: keyDoc._id },
    {
      $inc: { [`usage.${month}`]: 1 },
      $set: { lastUsedAt: new Date() },
    }
  );
}

export async function markKeyFailed(keyDoc) {
  const col = getKeysCollection();
  const month = currentMonthKey();
  await col.updateOne(
    { _id: keyDoc._id },
    {
      $inc: { [`usage.${month}`]: 1 },
      $set: { lastUsedAt: new Date(), lastError: new Date().toISOString() },
    }
  );
}

export async function addApiKey({ apiKey, apiSecret, label = '', note = '' }) {
  const col = getKeysCollection();
  const existing = await col.findOne({ apiKey });
  if (existing) {
    await col.updateOne({ apiKey }, { $set: { apiSecret, label, note, enabled: true, updatedAt: new Date() } });
    return existing._id.toString();
  }
  const doc = {
    apiKey,
    apiSecret,
    label,
    note,
    enabled: true,
    usage: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: null,
  };
  const res = await col.insertOne(doc);
  return res.insertedId.toString();
}

export async function listApiKeys() {
  const col = getKeysCollection();
  const docs = await col.find({}).sort({ createdAt: 1 }).toArray();
  return docs.map((d) => ({
    id: d._id.toString(),
    label: d.label || '',
    apiKey: d.apiKey ? d.apiKey.slice(0, 8) + '…' : '',
    enabled: !!d.enabled,
    usage: d.usage || {},
    lastUsedAt: d.lastUsedAt || null,
    createdAt: d.createdAt || null,
  }));
}

export async function toggleApiKey(id, enabled) {
  const col = getKeysCollection();
  const { ObjectId } = await import('mongodb');
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { enabled } });
}

export async function deleteApiKey(id) {
  const col = getKeysCollection();
  const { ObjectId } = await import('mongodb');
  await col.deleteOne({ _id: new ObjectId(id) });
}
