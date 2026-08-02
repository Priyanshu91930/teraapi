import {
  getNextApiKey,
  incrementKeyUsage,
  markKeyFailed,
} from './db.js';
import { extractWithKey, formatTeraboxdlList } from './teraboxdl.js';

/**
 * Resolve a TeraBox share link via teraboxdl.site API using
 * multi-account key rotation.
 *
 * Flow:
 * 1. Pick the least-used enabled API key (under monthly limit).
 * 2. Call the teraboxdl extraction API with HMAC-signed headers.
 * 3. On success, increment that key's usage counter.
 * 4. On failure (HTTP error / errno), mark the key failed and try the next key.
 * 5. Returns { ok, result } or { ok:false, error }.
 */
export async function resolveTeraboxdl({ url, dirPath = '', page = 1 }) {
  const attempted = [];

  for (let i = 0; i < 10; i++) {
    const keyDoc = await getNextApiKey(attempted);
    if (!keyDoc) {
      return {
        ok: false,
        error:
          'All teraboxdl API keys exhausted or hit monthly limit. Add more keys in MongoDB.',
        exhausted: true,
      };
    }
    attempted.push(keyDoc._id.toString());

    try {
      const data = await extractWithKey({
        apiKey: keyDoc.apiKey,
        apiSecret: keyDoc.apiSecret,
        url,
        dirPath,
        page,
      });
      await incrementKeyUsage(keyDoc);
      return { ok: true, result: formatTeraboxdlList(data) };
    } catch (e) {
      await markKeyFailed(keyDoc);
      if (i === 9) {
        return {
          ok: false,
          error: e.message || 'teraboxdl extraction failed',
          status: e.status,
        };
      }
    }
  }
  return { ok: false, error: 'teraboxdl extraction failed' };
}
