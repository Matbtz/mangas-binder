import { getProviderConfig } from '../core/settings.js';
import { fetchRetry } from '../download/limit.js';
import { throttle } from '../download/throttle.js';
import { solve as flareSolve, cookieHeader, isEnabled as flareEnabled } from '../download/flaresolverr.js';
import { logHistory } from '../core/db.js';

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

let _cachedFlareSession = null; // { cookieString, userAgent, ts }
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes
const _inflightFetches = new Map(); // url -> Promise<{ html, imageHeaders }>

export function _clearMangaKatanaCache() {
  _cachedFlareSession = null;
  _inflightFetches.clear();
  if (typeof _seriesChaptersCache !== 'undefined') _seriesChaptersCache.clear();
}

/**
 * Fetch a page's HTML. Reuses FlareSolverr session cookies when available
 * to bypass Cloudflare without re-running full headless browser solves.
 * Deduplicates inflight requests for the exact same URL.
 * @returns {Promise<{ html: string, imageHeaders: object }>}
 */
async function fetchPage(url, { signal } = {}) {
  let promise = _inflightFetches.get(url);
  if (!promise) {
    promise = _doFetchPage(url, { signal }).finally(() => _inflightFetches.delete(url));
    _inflightFetches.set(url, promise);
  }
  return promise;
}

async function _doFetchPage(url, { signal } = {}) {
  await throttle('mangakatana', throttleMs());
  if (flareEnabled()) {
    if (_cachedFlareSession && (Date.now() - _cachedFlareSession.ts < SESSION_TTL_MS)) {
      try {
        const res = await fetchRetry(url, {
          headers: {
            'User-Agent': _cachedFlareSession.userAgent,
            Cookie: _cachedFlareSession.cookieString,
            Referer: `${SITE}/`,
            Accept: 'text/html,application/xhtml+xml',
          },
          retries: 1,
          signal,
        });
        if (res.ok) {
          const html = await res.text();
          const imageHeaders = {
            'User-Agent': _cachedFlareSession.userAgent,
            Referer: `${SITE}/`,
          };
          if (_cachedFlareSession.cookieString) imageHeaders.Cookie = _cachedFlareSession.cookieString;
          return { html, imageHeaders };
        }
      } catch { /* session expired or blocked, fall through to solve */ }
    }

    try {
      const { html, cookies, userAgent } = await flareSolve(url, { signal });
      const cookieStr = cookieHeader(cookies);
      const ua = userAgent || BROWSER_UA;
      if (cookieStr) {
        _cachedFlareSession = { cookieString: cookieStr, userAgent: ua, ts: Date.now() };
      }
      const imageHeaders = {
        'User-Agent': ua,
        Referer: `${SITE}/`,
      };
      if (cookieStr) imageHeaders.Cookie = cookieStr;
      return { html, imageHeaders };
    } catch (solveErr) {
      logHistory('flaresolverr.error', { message: `FlareSolverr failed to solve ${url}: ${solveErr.message}. Falling back to direct fetch.` });
    }
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

export function parseSearchResults(html) {
  // If we were redirected directly to a series page, match it
  const pageUrlMatch = html.match(/var\s+page_url\s*=\s*'([^']+)'/i) || html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (pageUrlMatch) {
    const url = pageUrlMatch[1];
    if (url.includes('/manga/')) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const title = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
      return [{ url, title }];
    }
  }

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

/** Search MangaKatana by title or URL. Returns [{ url, title }]. */
export async function searchSeries(title, { signal } = {}) {
  if (/^https?:\/\/mangakatana\.com\/manga\/[^/]+/i.test(title)) {
    const { html } = await fetchPage(title, { signal });
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const resolvedTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'MangaKatana Series';
    return [{ url: title, title: resolvedTitle }];
  }
  const url = `${SITE}/?search=${encodeURIComponent(title)}&search_by=book_name`;
  const { html } = await fetchPage(url, { signal });
  return parseSearchResults(html);
}

/** Get series details from a MangaKatana series URL. */
export async function getSeries(idOrUrl) {
  const url = idOrUrl.startsWith('http') ? idOrUrl : `${SITE}${idOrUrl}`;
  const { html } = await fetchPage(url);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'MangaKatana Series';

  const coverMatch = html.match(/<div class="cover">[^]*?<img[^>]+src="([^"]+)"/i);
  const coverPath = coverMatch ? coverMatch[1] : null;

  const summaryMatch = html.match(/<div class="summary">[^]*?<p>([\s\S]*?)<\/p>/i);
  const description = summaryMatch ? summaryMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  return {
    title: title || 'MangaKatana Series',
    authors: [],
    artists: [],
    genres: [],
    description: description || '',
    year: null,
    status: 'ongoing',
    coverPath,
  };
}

const _seriesChaptersCache = new Map(); // url -> { chaptersMap, ts }
const CHAPTERS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getCachedChaptersMap(idOrUrl, { signal } = {}) {
  const url = idOrUrl.startsWith('http') ? idOrUrl : `${SITE}${idOrUrl}`;
  const cached = _seriesChaptersCache.get(url);
  if (cached && (Date.now() - cached.ts < CHAPTERS_CACHE_TTL_MS)) {
    return cached.chaptersMap;
  }
  const { html } = await fetchPage(url, { signal });
  const chaptersMap = parseChapterList(html);
  _seriesChaptersCache.set(url, { chaptersMap, ts: Date.now() });
  return chaptersMap;
}

/** List chapters for a series URL. */
export async function listChapters(idOrUrl, { lang = 'en' } = {}) {
  const chaptersMap = await getCachedChaptersMap(idOrUrl);
  
  const out = [];
  for (const [num, chUrl] of chaptersMap.entries()) {
    out.push({
      id: chUrl,
      number: num,
      volume: null,
      title: `Chapter ${num}`,
      lang,
    });
  }
  return out;
}

/** Get pages for a specific chapter URL. */
export async function getChapterPages(chapterUrl, { signal } = {}) {
  const { html, imageHeaders } = await fetchPage(chapterUrl, { signal });
  const images = parseChapterImages(html);
  if (!images.length) throw new Error(`MangaKatana returned no page images`);
  return images.map(url => ({ url, headers: imageHeaders }));
}

/**
 * Find the best matching URL for a chapter number, handling exact matches
 * first, and falling back to the latest increment (e.g. 9.2 for 9) if not found.
 */
export function resolveChapterUrl(chapters, chapterNumber) {
  const want = String(parseFloat(chapterNumber));
  let url = chapters.get(want);
  if (!url) {
    let bestKey = null;
    let bestVal = -1;
    const wantFloat = parseFloat(want);
    const isInteger = Number.isInteger(wantFloat);
    for (const key of chapters.keys()) {
      const keyFloat = parseFloat(key);
      const isMatch = isInteger
        ? (Math.floor(keyFloat) === wantFloat)
        : (key === want || key.startsWith(want + '.'));
      if (isMatch) {
        if (keyFloat > bestVal) {
          bestVal = keyFloat;
          bestKey = key;
        }
      }
    }
    if (bestKey) {
      url = chapters.get(bestKey);
    }
  }
  return url;
}

/**
 * Resolve the page images for a chapter on a known MangaKatana series page.
 * @param {string} seriesUrl  MangaKatana series landing URL
 * @param {string|number} chapterNumber
 * @returns {Promise<{ urls: Array<{url, headers}> }>}
 */
export async function findChapterPages(seriesUrl, chapterNumber, { signal } = {}) {
  const chapters = await getCachedChaptersMap(seriesUrl, { signal });
  const chapterUrl = resolveChapterUrl(chapters, chapterNumber);
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

export const provider = {
  name: 'mangakatana',
  label: 'MangaKatana',
  mediaType: 'manga',
  capabilities: { download: true, metadata: true, archive: false, pageFallback: true },
  // `search` is the base.js interface name the Add tab and /api/search call;
  // `searchSeries` stays too since download/fallback.js imports it directly.
  search: searchSeries,
  searchSeries,
  getSeries,
  listChapters,
  getChapterPages,
  findChapterPages,
  testConnection,
};
