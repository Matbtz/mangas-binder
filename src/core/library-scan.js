import { readdirSync, existsSync } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { config } from './config.js';
import { listSeries, getSeries, listChaptersForSeries, setChapterState } from './repo.js';
import { sanitize } from './library.js';
import { logHistory } from './db.js';

/**
 * Reconcile the on-disk Tome library with the database: find CBZs that already
 * exist, figure out which series/volume/chapters they represent, and mark those
 * chapters as `imported` so we never re-download or re-package them. The volume
 * read from the existing file becomes authoritative, so our volume boundaries
 * snap to whatever is already in your library.
 *
 * Works precisely on CBZs mangas-binder produced (chapter membership is encoded
 * in the page names, e.g. `ch0012_p003.jpg`). Foreign CBZs are matched at the
 * series/volume level but can't be reconciled per-chapter (no chapter list).
 */

const CBZ_PAGE_RE = /^ch(\d+(?:\.\d+)?)_p\d+/i;
const FILENAME_VOL_RE = /\bvol\.?\s*0*(\d+(?:\.\d+)?)/i;
const WEB_ID_RE = /mangadex\.org\/title\/([0-9a-f-]{36})/i;

function walkCbz(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkCbz(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.cbz')) out.push(full);
  }
  return out;
}

function tagText(xml, tag) {
  const m = xml?.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/**
 * Read identity + chapter membership from a CBZ.
 * @returns {{ series, mangadexId, volume, chapters: string[] }}
 */
export function readCbzInfo(filePath) {
  let series = null, mangadexId = null, chapters = [];
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const comic = entries.find(e => e.entryName.toLowerCase().endsWith('comicinfo.xml'));
    if (comic) {
      const xml = comic.getData().toString('utf-8');
      series = tagText(xml, 'Series');
      const web = tagText(xml, 'Web');
      mangadexId = web?.match(WEB_ID_RE)?.[1] || null;
    }
    const found = new Set();
    for (const e of entries) {
      const m = path.basename(e.entryName).match(CBZ_PAGE_RE);
      if (m) found.add(String(parseFloat(m[1])));
    }
    chapters = [...found];
  } catch { /* unreadable/corrupt CBZ — skip */ }

  const volMatch = path.basename(filePath).match(FILENAME_VOL_RE);
  const volume = volMatch ? String(parseFloat(volMatch[1])) : null;
  if (!series) series = path.basename(filePath).replace(/\.cbz$/i, '');
  return { series, mangadexId, volume, chapters };
}

/**
 * Scan the configured library dirs and mark owned chapters as imported.
 * Also discovers CBZs whose series isn't followed yet and returns them as
 * `untracked` suggestions.
 * @param {{ seriesId?: number }} opts  limit reconciliation to one series if given
 * @returns {{ files, matchedFiles, markedChapters, perSeries, untracked }}
 */
export function scanLibrary({ seriesId } = {}) {
  const all = listSeries();

  // Build lookup tables for all tracked series (not just the target) so we can
  // exclude them from the untracked suggestions.
  const allByMangadexId = new Map();
  const allByTitle = new Map();
  for (const s of all) {
    if (s.provider === 'mangadex') allByMangadexId.set(s.provider_series_id, s);
    allByTitle.set(sanitize(s.title).toLowerCase(), s);
  }

  const targets = seriesId ? [getSeries(seriesId)].filter(Boolean) : all;
  if (!targets.length && !seriesId) {
    // No series followed yet — still discover untracked
  }

  const byMangadexId = new Map(targets
    .filter(s => s.provider === 'mangadex')
    .map(s => [s.provider_series_id, s]));
  const byTitle = new Map(targets.map(s => [sanitize(s.title).toLowerCase(), s]));

  const files = [...new Set(config.libraryScanDirs.flatMap(d => walkCbz(d)))];
  const chaptersBySeries = new Map(); // seriesId -> Map(number -> row)
  let matchedFiles = 0, markedChapters = 0;
  const perSeries = {};

  // Accumulate untracked: keyed by mangadexId (or sanitized title as fallback)
  const untrackedMap = new Map(); // key -> { title, mangadexId, volumes: Set, files: [] }

  for (const file of files) {
    const info = readCbzInfo(file);

    // Check if this file belongs to any tracked series.
    const match = (info.mangadexId && byMangadexId.get(info.mangadexId))
      || byTitle.get(sanitize(info.series).toLowerCase());

    if (!match) {
      // Only surface as untracked if not tracked at all (not just outside current target).
      const isTracked = (info.mangadexId && allByMangadexId.has(info.mangadexId))
        || allByTitle.has(sanitize(info.series).toLowerCase());
      if (!isTracked) {
        const key = info.mangadexId || sanitize(info.series).toLowerCase();
        if (!untrackedMap.has(key)) {
          untrackedMap.set(key, { title: info.series, mangadexId: info.mangadexId, volumes: new Set(), files: [] });
        }
        const entry = untrackedMap.get(key);
        if (info.volume) entry.volumes.add(info.volume);
        entry.files.push(file);
      }
      continue;
    }

    if (seriesId && match.id !== seriesId) continue;
    matchedFiles++;

    if (!chaptersBySeries.has(match.id)) {
      chaptersBySeries.set(match.id, new Map(listChaptersForSeries(match.id).map(c => [c.number, c])));
    }
    const index = chaptersBySeries.get(match.id);

    for (const num of info.chapters) {
      const row = index.get(num);
      if (!row || row.state === 'imported') continue;
      // Owned: mark imported, point at the existing file, and adopt its volume
      // as authoritative (calculated = 0) so future packaging aligns to it.
      setChapterState(row.id, 'imported', {
        cbz_path: file,
        calculated: 0,
        ...(info.volume ? { volume: info.volume } : {}),
      });
      row.state = 'imported';
      markedChapters++;
      perSeries[match.title] = (perSeries[match.title] || 0) + 1;
    }
  }

  if (markedChapters > 0) {
    logHistory('library.scanned', { message: `marked ${markedChapters} owned chapter(s) across ${matchedFiles} file(s)` });
  }

  const untracked = [...untrackedMap.values()].map(e => ({
    title: e.title,
    mangadexId: e.mangadexId,
    volumes: [...e.volumes].sort((a, b) => parseFloat(a) - parseFloat(b)),
    fileCount: e.files.length,
  }));

  return { files: files.length, matchedFiles, markedChapters, perSeries, untracked };
}
