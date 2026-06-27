import { rm } from 'fs/promises';
import { getProvider } from '../providers/index.js';
import {
  getSeries, getChapter, chaptersInState, listChaptersForSeries, listChaptersInStates,
  setChapterState, bumpChapterAttempt, setChapterProgress,
} from '../core/repo.js';
import { getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';
import { downloadChapter, chapterStagingDir } from './downloader.js';
import { downloadArchiveChapter } from './archive-downloader.js';
import { downloadChapterViaFallback, fallbackEnabled } from './fallback.js';
import { bindChapter, bindVolume } from '../core/binder.js';
import { resolveVolumes } from '../core/mapping.js';
import { notifyImport, notifyError } from '../core/notify.js';
import { pLimit } from './limit.js';

const MAX_ATTEMPTS = 5;
let running = false;

/** chapterId → AbortController for downloads currently in flight (for cancellation). */
const inflight = new Map();

/** True if the error came from a user-requested cancellation rather than a real failure. */
const isAbort = (err) => err?.name === 'AbortError';

/**
 * Drain all `wanted` chapters: download pages, then either bind immediately
 * (chapter mode) or leave as `downloaded` for volume packaging. After downloads,
 * package any newly-complete volumes for affected series.
 *
 * Re-entrant guard prevents overlapping runs (scheduler + manual trigger).
 * @returns {Promise<{ processed, imported, failed }>}
 */
export async function runOnce({ limit = 200 } = {}) {
  if (running) return { processed: 0, imported: 0, failed: 0, skipped: 'already-running' };
  // Master kill-switch — when paused, the pipeline does nothing (no downloads,
  // no packaging). Lets you deploy/test without the app pulling files.
  if (getSetting('downloadsPaused', false)) {
    return { processed: 0, imported: 0, failed: 0, skipped: 'downloads-paused' };
  }
  running = true;
  try {
    const concurrency = getSetting('downloadConcurrency', 4);
    const chapterConcurrency = getSetting('chapterConcurrency', 2);
    const dataSaver = getSetting('dataSaver', false);
    const wanted = chaptersInState('wanted', limit);
    const affectedVolumeSeries = new Set();
    let processed = 0, imported = 0, failed = 0;

    // Pages download in parallel within a chapter (downloadConcurrency); chapters
    // run a few at a time (chapterConcurrency) to stay polite to the source.
    const limiter = pLimit(Math.max(1, chapterConcurrency));
    await Promise.all(wanted.map(ch => limiter(async () => {
      const series = getSeries(ch.series_id);
      if (!series || !series.monitored || series.monitor_mode === 'none') {
        setChapterState(ch.id, 'skipped', { error: null });
        return;
      }
      // Files come from the download/archive provider (= metadata provider for manga).
      const dlProvider = getProvider(series.download_provider || series.provider);

      const controller = new AbortController();
      inflight.set(ch.id, controller);
      setChapterState(ch.id, 'downloading', { error: null, prog_done: 0, prog_total: null, started_at: new Date().toISOString() });
      bumpChapterAttempt(ch.id);
      try {
        const customUrl = ch.download_url;
        const isArchiveUrl = customUrl && (customUrl.startsWith('http') || customUrl.endsWith('.cbz') || customUrl.endsWith('.zip'));
        const useArchive = dlProvider.capabilities.archive || isArchiveUrl;
        const activeProvider = isArchiveUrl ? getProvider('getcomics') : dlProvider;
        // Throttled progress writer (manga only; comics are a single archive = indeterminate).
        let lastWrite = 0;
        const onProgress = (done, total) => {
          const now = Date.now();
          if (done < total && now - lastWrite < 300) return;
          lastWrite = now;
          setChapterProgress(ch.id, done, total);
        };
        let dir, pageCount;
        // Track whether MangaDex flagged the chapter as permanently unavailable in
        // EN/FR. Used below to skip retries and settle on `not_found` instead.
        let primaryNotAvailable = false;
        if (useArchive) {
          ({ dir, pageCount } = await downloadArchiveChapter(activeProvider, series, ch, { signal: controller.signal })); // comics: whole CBZ/ZIP → pages
        } else {
          try {
            ({ dir, pageCount } = await downloadChapter(dlProvider, ch, { concurrency, dataSaver, mangaId: series.provider_series_id, signal: controller.signal, onProgress })); // manga: page images
          } catch (primaryErr) {
            // Capture "not available in EN/FR" before deciding whether to fallback.
            if (primaryErr.notAvailable) primaryNotAvailable = true;
            // MangaDex couldn't serve this chapter — fall back to scraping MangaKatana
            // for the same chapter (manga only, when the fallback is enabled).
            if (isAbort(primaryErr) || series.media_type !== 'manga' || !fallbackEnabled()) throw primaryErr;
            logHistory('fallback.attempt', { seriesId: series.id, chapterId: ch.id, message: `MangaDex failed (${primaryErr.message}); trying MangaKatana` });
            ({ dir, pageCount } = await downloadChapterViaFallback(series, ch, { signal: controller.signal, onProgress, concurrency }));
            logHistory('fallback.success', { seriesId: series.id, chapterId: ch.id, message: `Chapter ${ch.number} via MangaKatana` });
            primaryNotAvailable = false; // fallback succeeded — chapter is available
          }
        }
        setChapterState(ch.id, 'downloaded', { staging_path: dir, pages: pageCount, prog_done: pageCount, prog_total: pageCount });
        processed++;

        if (series.packaging_mode === 'chapter') {
          const res = await bindChapter(series, getChapter(ch.id));
          setChapterState(ch.id, 'bindery', { cbz_path: res.path });
          imported++;
          logHistory('chapter.packaged', { seriesId: series.id, chapterId: ch.id, message: res.path });
          notifyImport(series.title, `Chapter ${ch.number}`);
        } else {
          affectedVolumeSeries.add(series.id);
        }
      } catch (err) {
        if (isAbort(err)) {
          // User cancelled: settle on `skipped`, drop partial pages, don't count as a failure.
          setChapterState(ch.id, 'skipped', { error: null, prog_done: null, prog_total: null });
          await cleanupStaging(series.id, ch.number);
          logHistory('chapter.cancelled', { seriesId: series.id, chapterId: ch.id, message: `Chapter ${ch.number} cancelled` });
        } else if (primaryNotAvailable) {
          // MangaDex confirmed no EN/FR translation exists and all fallbacks also
          // failed. Mark permanently so it doesn't cycle through 5 retry attempts.
          setChapterState(ch.id, 'not_found', { error: String(err.message || err), prog_done: null, prog_total: null });
          logHistory('chapter.not_found', { seriesId: series.id, chapterId: ch.id, message: `Chapter ${ch.number}: ${err.message || err}` });
        } else {
          failed++;
          const fresh = getChapter(ch.id);
          const exhausted = (fresh?.attempts ?? 0) >= MAX_ATTEMPTS;
          setChapterState(ch.id, exhausted ? 'failed' : 'wanted', { error: String(err.message || err), prog_done: null, prog_total: null });
          logHistory('chapter.failed', { seriesId: series.id, chapterId: ch.id, message: String(err.message || err) });
          if (exhausted) notifyError(series.title, `Chapter ${ch.number}`, String(err.message || err));
        }
      } finally {
        inflight.delete(ch.id);
      }
    })));

    // Volume-mode: try to package any volumes that just became complete.
    for (const seriesId of affectedVolumeSeries) {
      imported += await packageCompleteVolumes(seriesId);
    }

    return { processed, imported, failed };
  } finally {
    running = false;
  }
}

/**
 * Cancel a chapter: abort it if downloading now, otherwise drop it from the
 * queue. Either way it settles on `skipped` (re-`want` it to resume). Staging
 * pages are cleaned up. No-op for terminal states (imported/skipped/failed).
 */
export async function cancelChapter(id) {
  const ch = getChapter(id);
  if (!ch) return { ok: false, error: 'not found' };
  const controller = inflight.get(id);
  if (controller) {
    controller.abort();
  }
  if (['wanted', 'queued', 'downloading', 'downloaded', 'bindery', 'failed'].includes(ch.state)) {
    setChapterState(id, 'skipped', { error: null, prog_done: null, prog_total: null });
    await cleanupStaging(ch.series_id, ch.number);
  }
  return { ok: true, aborted: !!controller };
}

/** Cancel every active (queued/in-flight/downloaded) chapter for a series. */
export async function cancelSeries(seriesId) {
  const active = listChaptersInStates(['wanted', 'queued', 'downloading', 'downloaded', 'bindery', 'failed'], { seriesId, limit: 100000 });
  for (const ch of active) await cancelChapter(ch.id);
  return { ok: true, cancelled: active.length };
}

async function cleanupStaging(seriesId, number) {
  if (getSetting('keepLoosePages', false)) return;
  await rm(chapterStagingDir(seriesId, number), { recursive: true, force: true }).catch(() => {});
}

/**
 * Bind every volume that is (a) fully downloaded and (b) "closed" — meaning a
 * higher-numbered volume already exists, or the series is marked complete. This
 * never packages the latest in-progress volume, so it won't emit partial CBZs.
 * Chapters with no volume assignment yet are left pending (MangaDex assigns
 * volumes late; a later refresh fills them in).
 *
 * @returns {Promise<number>} number of volumes imported
 */
export async function packageCompleteVolumes(seriesId) {
  const series = getSeries(seriesId);
  if (!series) return 0;

  // Assign estimated volumes to any untagged chapters before grouping.
  resolveVolumes(seriesId);

  const chapters = listChaptersForSeries(seriesId)
    .filter(c => c.state === 'downloaded' || c.state === 'imported');

  // Group chapters that have a numeric volume.
  const byVolume = new Map();
  let maxVolume = -Infinity;
  for (const c of chapters) {
    if (c.volume == null || c.volume === '') continue;
    const v = parseFloat(c.volume);
    if (Number.isNaN(v)) continue;
    maxVolume = Math.max(maxVolume, v);
    if (!byVolume.has(c.volume)) byVolume.set(c.volume, []);
    byVolume.get(c.volume).push(c);
  }
  if (!byVolume.size) return 0;

  const isComplete = series.status === 'completed' || series.status === 'cancelled';
  let coverMap = null;
  const provider = getProvider(series.provider);

  let importedVolumes = 0;
  for (const [volLabel, vchapters] of byVolume) {
    const v = parseFloat(volLabel);
    const closed = isComplete || v < maxVolume;          // a later volume exists
    const ready = vchapters.every(c => c.state === 'downloaded' || c.state === 'imported');
    const pending = vchapters.some(c => c.state === 'downloaded'); // something to import
    if (!closed || !ready || !pending) continue;

    if (coverMap === null && provider.getVolumeCovers) {
      coverMap = await provider.getVolumeCovers(series.provider_series_id).catch(() => new Map());
    }
    const coverUrl = coverMap?.get(String(v)) || coverMap?.get(volLabel) || null;
    const calculated = vchapters.some(c => c.calculated);

    try {
      const res = await bindVolume(series, volLabel, vchapters, { coverUrl, calculated, overwrite: true });
      for (const c of vchapters) {
        setChapterState(c.id, 'bindery', { cbz_path: res.path });
      }
      importedVolumes++;
      logHistory('volume.packaged', { seriesId, message: `${series.title} Vol. ${volLabel}${calculated ? ' (estimated)' : ''}` });
      notifyImport(series.title, `Volume ${volLabel}${calculated ? ' (estimated)' : ''}`);
    } catch (err) {
      logHistory('volume.failed', { seriesId, message: `Vol ${volLabel}: ${err.message || err}` });
      notifyError(series.title, `Volume ${volLabel}`, String(err.message || err));
    }
  }
  return importedVolumes;
}
