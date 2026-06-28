import { chapterStagingDir, fetchPagesToStaging } from './downloader.js';
import { provider as mangakatana } from '../providers/mangakatana.js';
import { titlesMatch, normTitle } from '../core/library.js';
import { isProviderEnabled, getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';
import { updateSeries } from '../core/repo.js';

/**
 * Page-image fallback: when the primary download provider (MangaDex@Home) can't
 * deliver a chapter, try scraping it from MangaKatana for the same series.
 *
 * Series are matched by title (no shared id between MangaDex and MangaKatana), so
 * the resolved MangaKatana series URL is cached per seriesId to avoid re-searching
 * on every chapter. Negative results are cached briefly to avoid hammering the
 * site for a series it doesn't carry. The cache is in-memory (re-resolves after a
 * restart — acceptable).
 */

const POS_TTL_MS = 24 * 60 * 60 * 1000; // resolved URL good for a day
const NEG_TTL_MS = 60 * 60 * 1000;      // re-try a "not found" after an hour
const _cache = new Map(); // seriesId -> { url: string|null, ts: number }

/** Is the MangaDex→MangaKatana page fallback active? */
export function fallbackEnabled() {
  return getSetting('mangaFallbackEnabled', false) && isProviderEnabled('mangakatana');
}

/** Resolve (and cache) the MangaKatana series URL best matching this series. */
export async function resolveSeriesUrl(series, { signal } = {}) {
  // Override via externalLinks if present
  if (series.externalLinks && series.externalLinks.mangakatana) {
    return series.externalLinks.mangakatana;
  }
  const hit = _cache.get(series.id);
  if (hit) {
    const ttl = hit.url ? POS_TTL_MS : NEG_TTL_MS;
    if (Date.now() - hit.ts < ttl) {
      if (hit.url) return hit.url;
      throw new Error(`MangaKatana has no match for "${series.title}" (cached)`);
    }
  }

  const results = await mangakatana.searchSeries(series.title, { signal });
  const wanted = normTitle(series.title);
  const exact = results.find(r => normTitle(r.title) === wanted);
  const best = exact || results.find(r => titlesMatch(series.title, r.title));

  if (!best) {
    _cache.set(series.id, { url: null, ts: Date.now() });
    throw new Error(`MangaKatana has no match for "${series.title}"`);
  }
  _cache.set(series.id, { url: best.url, ts: Date.now() });
  logHistory('fallback.resolved', { seriesId: series.id, message: `MangaKatana: ${best.title} → ${best.url}` });

  // Save resolved URL to database so it populates the external link field automatically
  if (!series.externalLinks || !series.externalLinks.mangakatana) {
    const currentLinks = series.externalLinks || {};
    currentLinks.mangakatana = best.url;
    try {
      updateSeries(series.id, { externalLinks: currentLinks });
    } catch (dbErr) {
      logHistory('fallback.save_error', { seriesId: series.id, message: `Failed to save MangaKatana URL to external links: ${dbErr.message}` });
    }
  }

  return best.url;
}

/** Forget a cached resolution (e.g. if it turned out to be wrong). */
export function forgetSeriesUrl(seriesId) { _cache.delete(seriesId); }

/**
 * Download a chapter's pages from MangaKatana into the normal staging dir,
 * reusing the shared resume/validation/atomic-write loop.
 * @returns {Promise<{ dir, pageCount }>}
 */
export async function downloadChapterViaFallback(series, chapter, { signal, onProgress, concurrency = 4 } = {}) {
  const seriesUrl = await resolveSeriesUrl(series, { signal });
  const { urls } = await mangakatana.findChapterPages(seriesUrl, chapter.number, { signal });
  const dir = chapterStagingDir(series.id, chapter.number);
  return fetchPagesToStaging(dir, urls, { concurrency, onProgress, signal });
}
