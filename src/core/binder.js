import { readFile, readdir, cp, mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { buildEntries, volumeCbzName, chapterCbzName, issueCbzName, downloadBuffer } from './packager.js';
import { buildComicInfoXml } from './comicinfo.js';
import { chapterStagingDir } from '../download/downloader.js';
import { writeCbz, destPath } from './library.js';
import { describeProfileForMedia } from './profiles.js';
import { isNoop, describeConfig, probeSharp } from './image-preprocess.js';
import { config } from './config.js';
import { extractToStaging, extractChaptersFromArchive } from '../download/archive-downloader.js';
import { getSeries, getChapter, listChaptersForSeries, setChapterState } from './repo.js';
import { getProvider } from '../providers/index.js';
import { getVolumeTitle } from './chapter-map-consensus.js';
import { logHistory } from './db.js';

/**
 * The binder: turns downloaded chapter page folders into Tome-ready CBZs with
 * embedded ComicInfo.xml, then writes them into the output (Tome) library.
 *
 * A "series" here is a row from the series table (JSON columns still strings).
 * A "chapter" is a row from the chapters table.
 */

function parseSeries(series) {
  const mediaType = series.media_type || 'manga';
  const web = series.provider === 'mangadex'
    ? `https://mangadex.org/title/${series.provider_series_id}`
    : series.provider === 'comicvine'
      ? `https://comicvine.gamespot.com/volume/4050-${series.provider_series_id}/`
      : '';
  return {
    title: series.title,
    authors: JSON.parse(series.authors_json || '[]'),
    artists: JSON.parse(series.artists_json || '[]'),
    genres: JSON.parse(series.genres_json || '[]'),
    description: series.description || '',
    year: series.year,
    mediaType,
    publisher: series.publisher || undefined,
    web,
  };
}

function comicInfoFor(series, { volumeNum = '', chapterNum = null, title = '', volumeTitle = '', calculated = false } = {}) {
  const s = parseSeries(series);
  return buildComicInfoXml({
    series: s.title,
    volumeNum,
    number: chapterNum,
    title,
    volumeTitle,
    authors: s.authors,
    artists: s.artists,
    description: s.description,
    genres: s.genres,
    year: s.year,
    web: s.web,
    publisher: s.publisher,
    mediaType: s.mediaType,
    isCalculated: calculated,
    language: series.language || 'en',
    // Total-volume consensus (when known) → <Count> for reader progress badges.
    totalVolumes: series.total_volumes_hint ?? null,
  });
}

async function maybeCover(coverUrl) {
  if (!coverUrl) return null;
  return downloadBuffer(coverUrl);
}

/** Create a scratch dir for processed pages, or null when no profile applies. */
async function makeWorkDir(preprocess) {
  if (!preprocess || isNoop(preprocess)) return null;
  await mkdir(config.stagingDir, { recursive: true });
  return mkdtemp(path.join(config.stagingDir, '.proc-'));
}

/**
 * Resolve what post-processing will actually happen for this packaging action
 * and log the decision to Activity > Logs. This is the single chokepoint every
 * packaging path (worker auto-package, manual single/batch package) runs
 * through, so the log always reflects what really ran.
 *
 * Crucially, when a profile is active it first probes sharp: if the image
 * library is unavailable it logs one clear `<event>.error` and returns no
 * config, so pages are packed unmodified deliberately instead of every page
 * throwing and falling back silently.
 *
 * @returns {Promise<{ cfg: object|null, status: string, profile: string|null, error: string|null }>}
 *   status ∈ 'disabled' | 'unassigned' | 'noop' | 'unavailable' | 'active'
 */
async function resolvePreprocess(baseEvent, label, series) {
  const mediaType = series.media_type || 'manga';
  const { enabled, profile, config: cfg } = describeProfileForMedia(mediaType);
  const log = (event, message) => logHistory(event, { seriesId: series.id, message });
  const none = (status, message, error = null) => {
    log(status === 'unavailable' ? `${baseEvent}.error` : baseEvent, message);
    return { cfg: null, status, profile: profile ? profile.name : null, error };
  };

  if (!enabled) return none('disabled', `${label}: post-processing disabled — pages packed unmodified`);
  if (!profile) return none('unassigned', `${label}: post-processing enabled but no profile assigned for ${mediaType} — pages packed unmodified`);
  if (isNoop(cfg)) return none('noop', `${label}: profile "${profile.name}" (${mediaType}) has no active treatments — pages packed unmodified`);

  // Profile is active — confirm the image library actually works here before
  // promising the treatments. A broken/missing sharp is the usual reason a
  // "post-processed" volume comes out byte-identical to an unprocessed one.
  const probe = await probeSharp();
  if (!probe.ok) {
    return none('unavailable', `${label}: profile "${profile.name}" active but image processing is unavailable (sharp: ${probe.error}) — all pages packed unmodified`, probe.error);
  }

  log(baseEvent, `${label}: profile "${profile.name}" (${mediaType}) — ${describeConfig(cfg).join(', ')}`);
  return { cfg, status: 'active', profile: profile.name, error: null };
}

/**
 * Log the outcome when pages fell back to unprocessed despite an active profile
 * (see buildEntries `stats`). Distinguishes a total pipeline failure (every
 * page) from a few isolated bad pages, and includes the first error so the log
 * shows the cause, not just a count.
 */
function logPostprocessFallback(baseEvent, label, series, stats) {
  if (!stats || !stats.failed) return;
  const total = stats.failed + stats.processed;
  const allFailed = stats.processed === 0;
  const reason = stats.firstError ? ` (first error: ${stats.firstError})` : '';
  logHistory(`${baseEvent}.${allFailed ? 'error' : 'warning'}`, {
    seriesId: series.id,
    message: allFailed
      ? `${label}: image processing failed for all ${total} page(s) — packed unmodified${reason}`
      : `${label}: ${stats.failed} of ${total} page(s) failed processing and were packed unmodified${reason}`,
  });
}

/** Compact, machine-readable post-processing outcome for API/UI (no log parsing). */
function summarizePostprocess(resolved, stats) {
  return {
    status: resolved.status,          // active | disabled | unassigned | noop | unavailable
    profile: resolved.profile,
    processed: stats.processed,
    failed: stats.failed,
    error: resolved.error || stats.firstError || null,
  };
}

/**
 * Bind a single chapter into its own CBZ (chapter packaging mode).
 * @returns {Promise<{ path, size, skipped }>}
 */
export async function bindChapter(series, chapter, { coverUrl = null } = {}) {
  const num = chapter.number;
  const label = `${series.title} #${num}`;
  const isComic = (series.media_type || 'manga') === 'comic';
  const localChapters = { [num]: chapterStagingDir(series.id, num) };
  const comicInfoXml = comicInfoFor(series, { chapterNum: num, title: chapter.title });
  const coverBuffer = await maybeCover(coverUrl);
  const resolved = await resolvePreprocess('chapter.postprocess', label, series);
  const workDir = await makeWorkDir(resolved.cfg);
  try {
    const stats = { processed: 0, failed: 0, firstError: null };
    const entries = await buildEntries([num], localChapters, { comicInfoXml, coverBuffer, preprocess: resolved.cfg, workDir, stats });
    logPostprocessFallback('chapter.postprocess', label, series, stats);
    const fileName = isComic ? issueCbzName(series.title, num) : chapterCbzName(series.title, num);
    const dest = destPath(series.title, fileName);
    // Always overwrite: a re-download or re-upload of a chapter that was already
    // packaged writes to this same deterministic path, and must replace the old
    // content rather than silently keep it (writeCbz's default skip-if-exists is
    // for first-time binds only — see bindVolume's callers, which force this too).
    const res = await writeCbz(entries, dest, { overwrite: true });
    return { ...res, postprocess: summarizePostprocess(resolved, stats) };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Bind a set of chapters that belong to one volume into a single volume CBZ.
 * @param {object} series
 * @param {string} volumeLabel   e.g. "12" (or "none" for unsorted)
 * @param {object[]} chapters    chapter rows in this volume
 * @param {{ calculated?: boolean, coverUrl?: string, overwrite?: boolean }} opts
 */
export async function bindVolume(series, volumeLabel, chapters, { calculated = false, coverUrl = null, overwrite = false } = {}) {
  // Restore pages for any chapter whose staging was cleared (e.g. `imported`
  // chapters, whose pages only live inside an existing CBZ). Without this, a
  // volume that mixes freshly-`downloaded` and already-`imported` chapters would
  // crash the binder on the missing staging dir and never package.
  // Chapters of one volume frequently share a single (already-imported) volume
  // CBZ as their cbz_path. Restoring each chapter independently used to re-read
  // AND re-parse that whole archive — often hundreds of MB on a NAS — once per
  // chapter. Read it once (archiveCache) and, for a shared packaged volume,
  // parse it once too (prewarmSharedArchives), extracting every needed chapter
  // in a single pass before the per-chapter restore loop.
  const archiveCache = new Map(); // cbz_path -> Promise<Buffer>
  await prewarmSharedArchives(series, chapters, archiveCache);
  const usable = [];
  for (const c of chapters) {
    if (await ensureChapterStaging(series, c, archiveCache)) usable.push(c);
  }
  const nums = usable.map(c => c.number);
  const localChapters = {};
  for (const n of nums) localChapters[n] = chapterStagingDir(series.id, n);

  // Best-effort localized tome title (e.g. "Romance Dawn" for One Piece vol 1)
  // from the cached cross-source chapter map, if one was resolved for this
  // series — falls back to the generic "<Series>, Vol. N" auto-title otherwise.
  const volumeTitle = volumeLabel !== 'none' ? getVolumeTitle(series, volumeLabel) : '';
  const comicInfoXml = comicInfoFor(series, { volumeNum: volumeLabel === 'none' ? '' : volumeLabel, volumeTitle, calculated });
  const coverBuffer = await maybeCover(coverUrl);
  const label = `${series.title} Vol. ${volumeLabel}`;
  const resolved = await resolvePreprocess('volume.postprocess', label, series);
  const workDir = await makeWorkDir(resolved.cfg);
  try {
    const stats = { processed: 0, failed: 0, firstError: null };
    const entries = await buildEntries(nums, localChapters, { comicInfoXml, coverBuffer, preprocess: resolved.cfg, workDir, stats });
    logPostprocessFallback('volume.postprocess', label, series, stats);
    const dest = destPath(series.title, volumeCbzName(series.title, volumeLabel));
    const res = await writeCbz(entries, dest, { overwrite });
    return { ...res, postprocess: summarizePostprocess(resolved, stats) };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when a chapter already has page images staged on disk. */
async function hasStaging(seriesId, number) {
  const dir = chapterStagingDir(seriesId, number);
  try {
    if (existsSync(dir)) {
      const files = await readdir(dir);
      if (files.some(f => /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(f))) return true;
    }
  } catch {}
  return false;
}

/**
 * Before restoring chapters one-by-one, extract every chapter that shares a
 * single packaged volume CBZ in ONE parse of that archive (see
 * extractChaptersFromArchive) — so re-packaging a 15-chapter volume parses the
 * archive once, not 15 times. Chapters already staged, or in a single-chapter /
 * foreign archive, are skipped and handled by the normal per-chapter path.
 */
async function prewarmSharedArchives(series, chapters, archiveCache) {
  const byArchive = new Map(); // cbz_path -> numbers[]
  for (const c of chapters) {
    const cbzPath = c.cbz_path || c.cbzPath;
    if (!cbzPath || !/\.(cbz|cbr|rar|zip)$/i.test(cbzPath) || !existsSync(cbzPath)) continue;
    if (c.state === 'downloaded' && await hasStaging(series.id, c.number)) continue;
    if (!byArchive.has(cbzPath)) byArchive.set(cbzPath, []);
    byArchive.get(cbzPath).push(c.number);
  }
  for (const [cbzPath, numbers] of byArchive) {
    if (numbers.length < 2) continue; // single chapter: per-chapter path is just as cheap
    try {
      if (!archiveCache.has(cbzPath)) archiveCache.set(cbzPath, readFile(cbzPath));
      const buf = await archiveCache.get(cbzPath);
      await extractChaptersFromArchive(buf, series.id, numbers);
    } catch { /* fall back to per-chapter ensureChapterStaging */ }
  }
}

/**
 * Ensure chapter pages exist in staging, restoring from cbz_path if needed.
 * `archiveCache` (optional) memoises the archive-read Promise per cbz_path so a
 * volume CBZ shared by several chapters is read from disk/NAS only once per bind.
 */
export async function ensureChapterStaging(series, chapter, archiveCache = null) {
  if (chapter.state === 'downloaded' && await hasStaging(series.id, chapter.number)) return true;

  const cbzPath = chapter.cbz_path || chapter.cbzPath;
  if (!cbzPath || !existsSync(cbzPath)) return false;

  const dir = chapterStagingDir(series.id, chapter.number);
  try {
    const st = statSync(cbzPath);
    if (st.isDirectory()) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await mkdir(dir, { recursive: true });
      await cp(cbzPath, dir, { recursive: true });
      return true;
    }
    if (/\.(cbz|cbr|rar|zip)$/i.test(cbzPath)) {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      let buf;
      if (archiveCache) {
        if (!archiveCache.has(cbzPath)) archiveCache.set(cbzPath, readFile(cbzPath));
        buf = await archiveCache.get(cbzPath);
      } else {
        buf = await readFile(cbzPath);
      }
      // Pull only this chapter's pages back out — cbz_path may be a multi-chapter
      // volume CBZ, in which case extracting the whole thing would duplicate pages.
      await extractToStaging(buf, series.id, chapter.number, { onlyChapter: chapter.number });
      return true;
    }
  } catch {}
  return false;
}

export async function packageSingleChapter(seriesId, chapterId) {
  const series = getSeries(seriesId);
  const chapter = getChapter(chapterId);
  if (!series || !chapter) throw new Error('Series or chapter not found');

  await ensureChapterStaging(series, chapter);
  const provider = getProvider(series.provider);
  let coverUrl = null;
  if (provider.getVolumeCovers && chapter.volume) {
    const covers = await provider.getVolumeCovers(series.provider_series_id).catch(() => new Map());
    coverUrl = covers.get(String(parseFloat(chapter.volume))) || null;
  }

  const res = await bindChapter(series, chapter, { coverUrl });
  setChapterState(chapter.id, 'bindery', { cbz_path: res.path });
  logHistory('chapter.packaged', { seriesId, chapterId, message: `Packaged ${series.title} #${chapter.number}` });
  return res;
}

export async function packageSingleVolume(seriesId, volumeKey) {
  const series = getSeries(seriesId);
  if (!series) throw new Error('Series not found');

  const chapters = listChaptersForSeries(seriesId).filter(c => (c.volume || 'none') === volumeKey);
  if (!chapters.length) throw new Error(`No chapters found in volume ${volumeKey}`);

  for (const c of chapters) {
    await ensureChapterStaging(series, c);
  }

  const provider = getProvider(series.provider);
  let coverUrl = null;
  if (provider.getVolumeCovers && volumeKey !== 'none' && volumeKey !== 'Specials') {
    const covers = await provider.getVolumeCovers(series.provider_series_id).catch(() => new Map());
    coverUrl = covers.get(String(parseFloat(volumeKey))) || covers.get(volumeKey) || null;
  }

  const calculated = chapters.some(c => c.calculated);
  const res = await bindVolume(series, volumeKey, chapters, { coverUrl, calculated, overwrite: true });
  for (const c of chapters) {
    setChapterState(c.id, 'bindery', { cbz_path: res.path });
  }
  logHistory('volume.packaged', { seriesId, message: `Packaged ${series.title} Vol. ${volumeKey}` });
  return res;
}

export function auditSeriesVolumes(seriesId) {
  const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
  const chapters = listChaptersForSeries(seriesId);
  const byVol = new Map();
  for (const c of chapters) {
    const vk = c.volume || 'none';
    if (vk === 'none' || vk === 'Specials') continue;
    if (!byVol.has(vk)) byVol.set(vk, []);
    byVol.get(vk).push(c);
  }

  if (!byVol.size) return [];

  const alerts = [];
  const sortedVols = [...byVol.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));

  for (const vk of sortedVols) {
    const vChapters = byVol.get(vk);
    const localChs = vChapters.filter(c => LOCAL_STATES.has(c.state));
    if (!localChs.length) continue;

    // Chapters the API knows about for this volume that we don't have locally
    // (skipped chapters are intentionally excluded and don't count as missing).
    const notLocal = vChapters.filter(c => !LOCAL_STATES.has(c.state) && c.state !== 'skipped');
    const isIncomplete = notLocal.length > 0;

    // Express missing chapters as ranges (e.g. "103..105") for display.
    const missingNums = notLocal
      .map(c => parseFloat(c.number))
      .filter(n => !Number.isNaN(n) && Number.isInteger(n))
      .sort((a, b) => a - b);
    const missingGaps = [];
    for (let i = 0; i < missingNums.length; ) {
      let start = missingNums[i], end = start;
      while (i + 1 < missingNums.length && missingNums[i + 1] === end + 1) { end = missingNums[++i]; }
      missingGaps.push(start === end ? `${start}` : `${start}..${end}`);
      i++;
    }

    const unexpectedLangs = [...new Set(
      localChs.filter(c => c.language !== 'en' && c.language !== 'fr').map(c => c.language)
    )];

    if (isIncomplete || unexpectedLangs.length > 0) {
      alerts.push({
        volumeKey: vk,
        localCount: localChs.length,
        totalCount: vChapters.length,
        isIncomplete,
        missingGaps,
        unexpectedLangs,
      });
    }
  }

  return alerts;
}
