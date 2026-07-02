// Small in-process TTL cache with in-flight de-duplication.
//
// Purpose: several read endpoints (latest device tests, dispatch summaries, plan insights)
// are polled every ~30s by every open screen. Within a short window the result is identical,
// so we collapse concurrent/near-concurrent calls for the same key into a single computation.
//
// Usage:
//   const { cachedCompute } = require("../utils/ttlCache");
//   const data = await cachedCompute(`latest:${planId}:${processId}`, 10000, () => runQuery());
//
// Notes:
//  - Cache is per Node process (fine for read-mostly metrics; not a correctness store).
//  - On rejection the entry is dropped so the next call retries.
//  - TTLs are short (seconds) so data is at most ~TTL stale — matching existing poll latency.

const store = new Map(); // key -> { expiresAt, value } | pending promise via `inflight`
const inflight = new Map(); // key -> Promise

async function cachedCompute(key, ttlMs, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const promise = (async () => {
    const value = await fn();
    store.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    store.delete(key); // don't cache failures
    throw err;
  } finally {
    inflight.delete(key);
  }
}

// Drop cache entries whose key starts with the given prefix (call after a mutation).
function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { cachedCompute, invalidatePrefix };
