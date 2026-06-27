import { sleep } from './limit.js';

/**
 * Per-key request throttle. Ensures at least `minIntervalMs` elapses between
 * successive calls that share a key (e.g. a provider name), so a scraper can't
 * hammer a site into an IP ban. This is the per-connector throttle HakuNeko uses
 * (typical values 200ms–5s); we key by provider so different sources don't block
 * each other.
 *
 * Implementation: each key holds a promise chain. A new caller waits for the
 * previous call's "ready" time, then reserves the next slot. No busy-waiting.
 *
 *   await throttle('mangakatana', 1000); // resolves when it's safe to fire
 *   const res = await fetch(...);
 */
const _chains = new Map(); // key -> Promise resolving to the timestamp the slot was taken

export function throttle(key, minIntervalMs = 0) {
  if (!minIntervalMs || minIntervalMs <= 0) return Promise.resolve();
  const prev = _chains.get(key) || Promise.resolve(0);
  const next = prev.then(async (lastAt) => {
    const now = Date.now();
    const wait = lastAt + minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    return Date.now();
  });
  // Swallow rejections so one failed turn doesn't poison the chain for the key.
  _chains.set(key, next.catch(() => Date.now()));
  return next;
}

/** Testing/reset hook. */
export function _resetThrottle() { _chains.clear(); }
