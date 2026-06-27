import { getProviderConfig } from '../core/settings.js';
import { fetchRetry } from '../download/limit.js';
import { throttle } from '../download/throttle.js';
import { solve as flareSolve, cookieHeader, isEnabled as flareEnabled } from '../download/flaresolverr.js';

/**
 * MangaKatana — a page-image *fallback* source for manga.
 *
 * It is NOT a primary provider: series are still followed via MangaDex (which
 * gives rich volume + MangaUpdates data). When a MangaDex page download fails,
 * the worker asks MangaKatana for the same chapter by (series title, number).
 *
 * MangaKatana has no public API and sits behind Cloudflare (a direct fetch
 * returns HTTP 403), so all page fetches go through FlareSolverr when configured.
 * FlareSolverr returns the solved HTML plus the cf_clearance cookie and the exact
 * User-Agent it used — both must be reused on the image-CDN requests, together
 * with a Referer, or the CDN rejects them.
 *
 * ⚠️ HTML scraper of a third-party site: markup changes without notice, so all
 * parsing is isolated here and tolerant (falls back across strategies).
 */

const SITE = 'https://mangakatana.com';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function throttleMs() {
  const v = Number(getProviderConfig('mangakatana')?.throttleMs);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

/**
 * Fetch a page's HTML. Through FlareSolverr when configured (to clear Cloudflare),
 * else a plain browser-like fetch. Returns the HTML plus the headers to reuse for
 * subsequent image-CDN requests from the same site.
 * @returns {Promise<{ html: string, imageHeaders: object }>}
 */
async function fetchPage(url, { signal } = {}) {
  await throttle('mangakatana', throttleMs());
  if (flareEnabled()) {
    const { html, cookies, userAgent } = await flareSolve(url, { signal });
    const imageHeaders = {
      'User-Agent': userAgent || BROWSER_UA,
      Referer: `${SITE}/`,
    };
    const cookie = cookieHeader(cookies);
    if (cookie) imageHeaders.Cookie = cookie;
    return { html, imageHeaders };
  }
  // No FlareSolverr: best-effort plain fetch (likely 403 if Cloudflare is active).
  const res = await fetchRetry(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml', Referer: `${SITE}/` },
    retries: 2,
    signal,
  });
  if (!res.ok) {
    throw new Error(`MangaKatana HTTP ${res.status}${res.status === 403 ? ' (Cloudflare — configure FlareSolverr)' : ''}`);
  }
  return { html: await res.text(), imageHeaders: { 'User-Agent': BROWSER_UA, Referer: `${SITE}/` } };
}

/** Parse search results into [{ url, title }]. */
export function parseSearchResults(html) {
  const out = [];
  const seen = new Set();
  // Result anchors point at /manga/<slug>.<id> and carry the series title.
  const re = /<a[^>]+href="(https?:\/\/mangakatana\.com\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].split('#')[0];
    // Skip chapter links (…/cN); we only want the series landing page.
    if (/\/c\d/i.test(url.replace(/^https?:\/\/mangakatana\.com\/manga\/[^/]+/i, ''))) continue;
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (url && title && !seen.has(url)) { seen.add(url); out.push({ url, title }); }
  }
  return out;
}

/** Parse a series page into a Map(chapterNumber -> chapterUrl). */
export function parseChapterList(html) {
  const map = new Map();
  const re = /href="(https?:\/\/mangakatana\.com\/manga\/[^"]+\/c(\d+(?:\.\d+)?)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].split('#')[0];
    const num = String(parseFloat(m[2]));
    if (!map.has(num)) map.set(num, url);
  }
  return map;
}

/**
 * Extract page-image URLs from a chapter page. MangaKatana builds the reader from
 * an inline-script array of image URLs; we read those first, then fall back to
 * <img data-src> attributes. Non-content images (logos/ads/static) are filtered.
 */
export function parseChapterImages(html) {
  const isContent = (u) => /\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(u)
    && !/(logo|banner|icon|avatar|favicon|\/static\/|\/wp-|ads?\/)/i.test(u);

  // Strategy 1: inline-script array(s) of quoted image URLs (the reader source).
  for (const script of html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || []) {
    if (!/\.(jpg|jpeg|png|webp)/i.test(script)) continue;
    const urls = (script.match(/https?:\/\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|gif)/gi) || []).filter(isContent);
    if (urls.length >= 2) return [...new Set(urls)];
  }

  // Strategy 2: <img src/data-src> inside the reader container.
  const imgs = [];
  const re = /<img[^>]+(?:data-src|src)="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1].trim();
    if (isContent(u)) imgs.push(u);
  }
  return [...new Set(imgs)];
}

/** Search MangaKatana by title. Returns [{ url, title }]. */
export async function searchSeries(title, { signal } = {}) {
  const url = `${SITE}/?search=${encodeURIComponent(title)}&search_by=book_name`;
  const { html } = await fetchPage(url, { signal });
  return parseSearchResults(html);
}

/**
 * Resolve the page images for a chapter on a known MangaKatana series page.
 * @param {string} seriesUrl  MangaKatana series landing URL
 * @param {string|number} chapterNumber
 * @returns {Promise<{ urls: Array<{url, headers}> }>}
 */
export async function findChapterPages(seriesUrl, chapterNumber, { signal } = {}) {
  const { html } = await fetchPage(seriesUrl, { signal });
  const chapters = parseChapterList(html);
  const want = String(parseFloat(chapterNumber));
  const chapterUrl = chapters.get(want);
  if (!chapterUrl) throw new Error(`MangaKatana has no chapter ${chapterNumber} for this series`);

  const { html: chHtml, imageHeaders } = await fetchPage(chapterUrl, { signal });
  const images = parseChapterImages(chHtml);
  if (!images.length) throw new Error(`MangaKatana returned no page images for chapter ${chapterNumber}`);
  return { urls: images.map(url => ({ url, headers: imageHeaders })) };
}

/** Reachability / Cloudflare check for the Settings "Test connection" button. */
export async function testConnection() {
  const { html } = await fetchPage(`${SITE}/`);
  if (!/mangakatana/i.test(html)) throw new Error('Unexpected response from MangaKatana');
  return { message: flareEnabled() ? 'Reached MangaKatana via FlareSolverr.' : 'Reached MangaKatana (no FlareSolverr — may hit Cloudflare).' };
}

/**
 * Fallback page-source provider. `pageFallback` keeps it out of the normal
 * download/archive selection — it's only invoked by the worker when the primary
 * source fails.
 */
export const provider = {
  name: 'mangakatana',
  label: 'MangaKatana',
  mediaType: 'manga',
  capabilities: { download: false, metadata: false, archive: false, pageFallback: true },
  searchSeries,
  findChapterPages,
  testConnection,
};
