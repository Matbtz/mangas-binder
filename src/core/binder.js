import { readFile, readdir, cp, mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { buildEntries, volumeCbzName, chapterCbzName, issueCbzName, downloadBuffer } from './packager.js';
import { buildComicInfoXml } from './comicinfo.js';
import { chapterStagingDir } from '../download/downloader.js';
import { writeCbz, destPath } from './library.js';
import { resolveProfileForMedia } from './profiles.js';
import { config } from './config.js';
import { extractToStaging } from '../download/archive-downloader.js';
import { getSeries, getChapter, listChaptersForSeries, setChapterState } from './repo.js';
import { getProvider } from '../providers/index.js';
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

function comicInfoFor(series, { volumeNum = '', chapterNum = null, title = '', calculated = false } = {}) {
  const s = parseSeries(series);
  return buildComicInfoXml({
    series: s.title,
    volumeNum,
    number: chapterNum,
    title,
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
  });
}

async function maybeCover(coverUrl) {
  if (!coverUrl) return null;
  return downloadBuffer(coverUrl);
}

/** Create a scratch dir for processed pages, or null when no profile applies. */
async function makeWorkDir(preprocess) {
  if (!preprocess) return null;
  await mkdir(config.stagingDir, { recursive: true });
  return mkdtemp(path.join(config.stagingDir, '.proc-'));
}

/**
 * Bind a single chapter into its own CBZ (chapter packaging mode).
 * @returns {Promise<{ path, size, skipped }>}
 */
export async function bindChapter(series, chapter, { coverUrl = null } = {}) {
  const num = chapter.number;
  const isComic = (series.media_type || 'manga') === 'comic';
  const localChapters = { [num]: chapterStagingDir(series.id, num) };
  const comicInfoXml = comicInfoFor(series, { chapterNum: num, title: chapter.title });
  const coverBuffer = await maybeCover(coverUrl);
  const preprocess = resolveProfileForMedia(series.media_type || 'manga');
  const workDir = await makeWorkDir(preprocess);
  try {
    const entries = await buildEntries([num], localChapters, { comicInfoXml, coverBuffer, preprocess, workDir });
    const fileName = isComic ? issueCbzName(series.title, num) : chapterCbzName(series.title, num);
    const dest = destPath(series.title, fileName);
    return await writeCbz(entries, dest);
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
  const usable = [];
  for (const c of chapters) {
    if (await ensureChapterStaging(series, c)) usable.push(c);
  }
  const nums = usable.map(c => c.number);
  const localChapters = {};
  for (const n of nums) localChapters[n] = chapterStagingDir(series.id, n);

  const comicInfoXml = comicInfoFor(series, { volumeNum: volumeLabel === 'none' ? '' : volumeLabel, calculated });
  const coverBuffer = await maybeCover(coverUrl);
  const preprocess = resolveProfileForMedia(series.media_type || 'manga');
  const workDir = await makeWorkDir(preprocess);
  try {
    const entries = await buildEntries(nums, localChapters, { comicInfoXml, coverBuffer, preprocess, workDir });
    const dest = destPath(series.title, volumeCbzName(series.title, volumeLabel));
    return await writeCbz(entries, dest, { overwrite });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ensure chapter pages exist in staging, restoring from cbz_path if needed. */
export async function ensureChapterStaging(series, chapter) {
  const dir = chapterStagingDir(series.id, chapter.number);
  try {
    if (existsSync(dir)) {
      const files = await readdir(dir);
      if (files.some(f => /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(f))) return true;
    }
  } catch {}

  const cbzPath = chapter.cbz_path || chapter.cbzPath;
  if (!cbzPath || !existsSync(cbzPath)) return false;

  try {
    const st = statSync(cbzPath);
    if (st.isDirectory()) {
      await mkdir(dir, { recursive: true });
      await cp(cbzPath, dir, { recursive: true });
      return true;
    }
    if (/\.(cbz|zip)$/i.test(cbzPath)) {
      const buf = await readFile(cbzPath);
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
