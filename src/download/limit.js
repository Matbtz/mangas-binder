/**
 * Minimal concurrency limiter (no dependency). Returns a function that wraps
 * async tasks so at most `n` run at once.
 *
 *   const limit = pLimit(4);
 *   await Promise.all(urls.map(u => limit(() => fetchPage(u))));
 */
export function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch with retry + exponential backoff. Retries on network errors, 429, and
 * 5xx. Honors Retry-After on 429 when present.
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, { retries = 4, baseDelay = 1000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = ra ? ra * 1000 : baseDelay * 2 ** attempt;
        if (attempt < retries) { await sleep(wait); continue; }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) { await sleep(baseDelay * 2 ** attempt); continue; }
    }
  }
  throw lastErr || new Error(`Failed to fetch after ${retries} retries: ${url}`);
}
