import { buildEntries, volumeCbzName, chapterCbzName, downloadBuffer } from './packager.js';
import { buildComicInfoXml } from './comicinfo.js';
import { chapterStagingDir } from '../download/downloader.js';
import { writeCbz, destPath } from './library.js';

/**
 * The binder: turns downloaded chapter page folders into Tome-ready CBZs with
 * embedded ComicInfo.xml, then writes them into the output (Tome) library.
 *
 * A "series" here is a row from the series table (JSON columns still strings).
 * A "chapter" is a row from the chapters table.
 */

function parseSeries(series) {
  return {
    title: series.title,
    authors: JSON.parse(series.authors_json || '[]'),
    artists: JSON.parse(series.artists_json || '[]'),
    genres: JSON.parse(series.genres_json || '[]'),
    description: series.description || '',
    year: series.year,
    mangadexId: series.provider === 'mangadex' ? series.provider_series_id : undefined,
  };
}

function comicInfoFor(series, { volumeNum = '', chapterNum = null, calculated = false } = {}) {
  const s = parseSeries(series);
  return buildComicInfoXml({
    series: s.title,
    volumeNum,
    number: chapterNum,
    authors: s.authors,
    artists: s.artists,
    description: s.description,
    genres: s.genres,
    year: s.year,
    mangadexId: s.mangadexId,
    isCalculated: calculated,
    language: series.language || 'en',
  });
}

async function maybeCover(coverUrl) {
  if (!coverUrl) return null;
  return downloadBuffer(coverUrl);
}

/**
 * Bind a single chapter into its own CBZ (chapter packaging mode).
 * @returns {Promise<{ path, size, skipped }>}
 */
export async function bindChapter(series, chapter, { coverUrl = null } = {}) {
  const num = chapter.number;
  const localChapters = { [num]: chapterStagingDir(series.id, num) };
  const comicInfoXml = comicInfoFor(series, { chapterNum: num });
  const coverBuffer = await maybeCover(coverUrl);
  const entries = await buildEntries([num], localChapters, { comicInfoXml, coverBuffer });
  const dest = destPath(series.title, chapterCbzName(series.title, num));
  return writeCbz(entries, dest);
}

/**
 * Bind a set of chapters that belong to one volume into a single volume CBZ.
 * @param {object} series
 * @param {string} volumeLabel   e.g. "12" (or "none" for unsorted)
 * @param {object[]} chapters    chapter rows in this volume
 * @param {{ calculated?: boolean, coverUrl?: string, overwrite?: boolean }} opts
 */
export async function bindVolume(series, volumeLabel, chapters, { calculated = false, coverUrl = null, overwrite = false } = {}) {
  const nums = chapters.map(c => c.number);
  const localChapters = {};
  for (const n of nums) localChapters[n] = chapterStagingDir(series.id, n);

  const comicInfoXml = comicInfoFor(series, { volumeNum: volumeLabel === 'none' ? '' : volumeLabel, calculated });
  const coverBuffer = await maybeCover(coverUrl);
  const entries = await buildEntries(nums, localChapters, { comicInfoXml, coverBuffer });
  const dest = destPath(series.title, volumeCbzName(series.title, volumeLabel));
  return writeCbz(entries, dest, { overwrite });
}
