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
  // Confirmed live memory leak (2026-09-19): store never removed an expired
  // entry unless that exact key happened to be requested again - many keys
  // here are scoped to a specific plan/process/device combination that stops
  // being polled once that work finishes, so those entries (and whatever
  // value they cached) sat in memory forever. Sweep expired entries
  // opportunistically once the map is large enough that a full pass is
  // worth it, same pattern as operatorTodayStatsCache in planInsightsService.js.
  if (store.size > 500) {
    for (const [entryKey, entry] of store) {
      if (entry.expiresAt <= now) store.delete(entryKey);
    }
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
