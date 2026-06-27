import { getSetting } from '../core/settings.js';
import { config } from '../core/config.js';

/**
 * Thin client for the FlareSolverr v1 API (https://github.com/FlareSolverr/FlareSolverr).
 *
 * FlareSolverr runs a real (headless) browser to solve Cloudflare / anti-bot
 * challenges, then returns the page HTML *plus* the cookies it obtained
 * (notably `cf_clearance`) and the exact User-Agent it used. To keep those
 * cookies valid on follow-up requests (e.g. fetching image files from a CDN),
 * the caller must reuse BOTH the cookies and that same User-Agent.
 *
 * Endpoint comes from the `flaresolverrUrl` setting (seeded from FLARESOLVERR_URL).
 * Empty/unset => FlareSolverr is disabled and solve() throws a clear error.
 */

/** Configured endpoint, e.g. http://flaresolverr:8191/v1 — or '' when disabled. */
export function flaresolverrUrl() {
  return getSetting('flaresolverrUrl', config.defaults.flaresolverrUrl || '') || '';
}

export function isEnabled() {
  return !!flaresolverrUrl();
}

/**
 * Solve a GET request through FlareSolverr.
 * @param {string} url
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ html: string, cookies: Array, userAgent: string, status: number }>}
 */
export async function solve(url, { timeoutMs = 60000, signal } = {}) {
  const endpoint = flaresolverrUrl();
  if (!endpoint) {
    throw new Error('FlareSolverr is not configured — set the FlareSolverr URL in Settings → Sources');
  }
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: timeoutMs }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`FlareSolverr unreachable at ${endpoint}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status} at ${endpoint}`);

  const data = await res.json();
  if (data.status !== 'ok' || !data.solution) {
    throw new Error(`FlareSolverr failed to solve ${url}: ${data.message || data.status || 'unknown error'}`);
  }
  const s = data.solution;
  return {
    html: s.response || '',
    cookies: s.cookies || [],
    userAgent: s.userAgent || '',
    status: s.status ?? 0,
  };
}

/** Build a `Cookie:` header value from FlareSolverr's cookie array. */
export function cookieHeader(cookies = []) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}
