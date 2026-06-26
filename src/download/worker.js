import { rm } from 'fs/promises';
import { getProvider } from '../providers/index.js';
import {
  getSeries, getChapter, chaptersInState, listChaptersForSeries,
  setChapterState, bumpChapterAttempt,
} from '../core/repo.js';
import { getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';
import { downloadChapter, chapterStagingDir } from './downloader.js';
import { downloadArchiveChapter } from './archive-downloader.js';
import { bindChapter, bindVolume } from '../core/binder.js';
import { resolveVolumes } from '../core/mapping.js';
import { notifyImport, notifyError } from '../core/notify.js';
import { pLimit } from './limit.js';

const MAX_ATTEMPTS = 5;
let running = false;

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
      if (!series) return;
      // Files come from the download/archive provider (= metadata provider for manga).
      const dlProvider = getProvider(series.download_provider || series.provider);

      setChapterState(ch.id, 'downloading', { error: null });
      bumpChapterAttempt(ch.id);
      try {
        const { dir, pageCount } = dlProvider.capabilities.archive
          ? await downloadArchiveChapter(dlProvider, series, ch)            // comics: whole CBZ/ZIP → pages
          : await downloadChapter(dlProvider, ch, { concurrency, dataSaver }); // manga: page images
        setChapterState(ch.id, 'downloaded', { staging_path: dir, pages: pageCount });
        processed++;

        if (series.packaging_mode === 'chapter') {
          const res = await bindChapter(series, getChapter(ch.id));
          setChapterState(ch.id, 'imported', { cbz_path: res.path });
          imported++;
          logHistory('chapter.imported', { seriesId: series.id, chapterId: ch.id, message: res.path });
          notifyImport(series.title, `Chapter ${ch.number}`);
          await cleanupStaging(series.id, ch.number);
        } else {
          affectedVolumeSeries.add(series.id);
        }
      } catch (err) {
        failed++;
        const fresh = getChapter(ch.id);
        const exhausted = (fresh?.attempts ?? 0) >= MAX_ATTEMPTS;
        setChapterState(ch.id, exhausted ? 'failed' : 'wanted', { error: String(err.message || err) });
        logHistory('chapter.failed', { seriesId: series.id, chapterId: ch.id, message: String(err.message || err) });
        if (exhausted) notifyError(series.title, `Chapter ${ch.number}`, String(err.message || err));
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
        setChapterState(c.id, 'imported', { cbz_path: res.path });
        await cleanupStaging(seriesId, c.number);
      }
      importedVolumes++;
      logHistory('volume.imported', { seriesId, message: `${series.title} Vol. ${volLabel}${calculated ? ' (estimated)' : ''}` });
      notifyImport(series.title, `Volume ${volLabel}${calculated ? ' (estimated)' : ''}`);
    } catch (err) {
      logHistory('volume.failed', { seriesId, message: `Vol ${volLabel}: ${err.message || err}` });
      notifyError(series.title, `Volume ${volLabel}`, String(err.message || err));
    }
  }
  return importedVolumes;
}
