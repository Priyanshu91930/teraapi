import { getDb, addApiKey, closeDb, listApiKeys } from './db.js';
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const rawKeys = process.env.TERABOXDL_KEYS;
const keys = [];

if (rawKeys) {
  try {
    const parsed = JSON.parse(rawKeys);
    for (const [i, k] of parsed.entries()) {
      keys.push({
        apiKey: k.apiKey,
        apiSecret: k.apiSecret,
        label: k.label || `Account ${i + 1}`,
      });
    }
  } catch (e) {
    console.error('Invalid TERABOXDL_KEYS JSON:', e.message);
    process.exit(1);
  }
}

if (keys.length === 0) {
  console.error('No keys found. Set TERABOXDL_KEYS env as JSON array:');
  console.error('[{"apiKey":"...","apiSecret":"...","label":"Account 1"}, ...]');
  process.exit(1);
}

try {
  await getDb();
  for (const k of keys) {
    const id = await addApiKey(k);
    console.log(`Added: ${k.label} → ${id}`);
  }
  const all = await listApiKeys();
  console.log('Keys in DB:', all.length);
  console.log(JSON.stringify(all, null, 2));
  await closeDb();
  process.exit(0);
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
}
