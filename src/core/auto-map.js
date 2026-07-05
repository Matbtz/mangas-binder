import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { readCbzInfo } from './library-scan.js';
import { listChaptersForSeries, getSeries, setChapterState } from './repo.js';
import { sanitize } from './library.js';
import { config } from './config.js';
import { getSetting } from './settings.js';

const PACKAGED_STATES = new Set(['imported', 'bindery', 'downloaded']);

/**
 * Suggest file→chapter mappings for one directory by reading each CBZ/EPUB's
 * ComicInfo + filename and matching it against the series' chapters. This is
 * the single source of truth behind both the manual "Auto-match" button
 * (Manage Files) and the automatic reconcile run by Refresh & Scan — a file
 * named for a volume ("Pet v03.cbz") maps to every chapter the provider placed
 * in that volume, so the on-disk library snaps onto the freshly-proposed
 * volume structure.
 *
 * @returns {Promise<{ suggestions: Array<{chapterId, chapterNumber, chapterTitle, filePath, matchReason}>, totalFiles: number, matchedFiles: number }>}
 */
export async function autoMapSuggestions(series, dir) {
  const chapters = listChaptersForSeries(series.id);
  const byNumber = new Map(chapters.map(c => [String(parseFloat(c.number)), c]));
  const byVolume = new Map();
  for (const c of chapters) {
    if (c.volume != null && c.volume !== '') {
      const vk = String(parseFloat(c.volume));
      if (!byVolume.has(vk)) byVolume.set(vk, []);
      byVolume.get(vk).push(c);
    }
  }

  const suggestions = [];
  const usedFiles = new Set();
  const usedChapters = new Set();

  const files = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const ext = e.name.toLowerCase();
      if (e.isFile() && (ext.endsWith('.cbz') || ext.endsWith('.epub'))) files.push(path.join(dir, e.name));
    }
  } catch { return { suggestions: [], totalFiles: 0, matchedFiles: 0 }; }
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));

  for (const filePath of files) {
    const info = await readCbzInfo(filePath);

    // 1. Issue number (comics: "#10 v10.cbz" → chapter 10)
    if (info.issueNum && byNumber.has(info.issueNum) && !usedChapters.has(info.issueNum)) {
      const ch = byNumber.get(info.issueNum);
      suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `issue #${info.issueNum}` });
      usedFiles.add(filePath); usedChapters.add(info.issueNum);
      continue;
    }

    // 2. Volume in filename → every chapter the provider placed in that volume
    if (info.volume) {
      const volChaps = byVolume.get(String(parseFloat(info.volume)));
      if (volChaps && volChaps.length > 0) {
        for (const ch of volChaps) {
          if (!usedChapters.has(ch.number)) {
            suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `vol ${info.volume}` });
            usedChapters.add(ch.number);
          }
        }
        usedFiles.add(filePath);
        continue;
      }
    }

    // 3. Bare-number fallback: extract the last number from the filename and try
    //    it as a volume first, then as a chapter number.
    const base = path.basename(filePath).replace(/\.(cbz|epub)$/i, '');
    const bareM = base.match(/(?:^|[-_\s])0*(\d{1,4}(?:\.\d+)?)(?:$|[-_\s.])/);
    if (bareM) {
      const vNum = String(parseFloat(bareM[1]));
      const volChaps = byVolume.get(vNum);
      if (volChaps && volChaps.length > 0) {
        for (const ch of volChaps) {
          if (!usedChapters.has(ch.number)) {
            suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `bare #${vNum}` });
            usedChapters.add(ch.number);
          }
        }
        usedFiles.add(filePath);
        continue;
      }
      if (byNumber.has(vNum) && !usedChapters.has(vNum)) {
        const ch = byNumber.get(vNum);
        suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `bare ch ${vNum}` });
        usedFiles.add(filePath); usedChapters.add(vNum);
      }
    }
  }

  return { suggestions, totalFiles: files.length, matchedFiles: usedFiles.size };
}

/**
 * Resolve the on-disk directories that belong to a series: its explicitly
 * linked folder_path plus any library-scan-dir subfolder named after the
 * title. Mirrors how library-scan.js locates a series' subtree.
 */
export function resolveSeriesDirs(series) {
  const dirs = new Set();
  const custom = series.folder_path || series.folderPath;
  if (custom && existsSync(custom)) dirs.add(custom);

  const titleKey = sanitize(series.title).toLowerCase();
  const dirsSetting = getSetting('libraryScanDirs', '');
  const scanDirs = dirsSetting
    ? dirsSetting.split(',').map(d => d.trim()).filter(Boolean)
        .map(p => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)))
    : config.libraryScanDirs;
  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) continue;
    try {
      for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
        if (entry.isDirectory() && sanitize(entry.name).toLowerCase() === titleKey) {
          dirs.add(path.join(scanDir, entry.name));
        }
      }
    } catch { /* unreadable scan dir — skip */ }
  }
  return [...dirs];
}

/**
 * Auto-match a series' on-disk files to its (provider-proposed) volume
 * structure and mark the matched chapters as owned. Runs the same matching as
 * the manual "Auto-match" button across every directory that belongs to the
 * series, then applies the volume/chapter mappings — skipping chapters already
 * reconciled by the (more precise, page-name based) library scan so it only
 * fills the gaps that scan left, e.g. bare-numbered volume files.
 *
 * @returns {Promise<{ applied: number, matchedFiles: number, totalFiles: number, dirs: string[] }>}
 */
export async function autoMatchSeriesFromDisk(seriesId) {
  const series = getSeries(seriesId);
  if (!series) return { applied: 0, matchedFiles: 0, totalFiles: 0, dirs: [] };

  const dirs = resolveSeriesDirs(series);
  const byId = new Map(listChaptersForSeries(seriesId).map(c => [c.id, c]));
  let applied = 0, matchedFiles = 0, totalFiles = 0;

  for (const dir of dirs) {
    const { suggestions, totalFiles: tf, matchedFiles: mf } = await autoMapSuggestions(series, dir);
    totalFiles += tf;
    matchedFiles += mf;
    for (const sg of suggestions) {
      const ch = byId.get(sg.chapterId);
      // Don't clobber a chapter the library scan already tied to a specific
      // file — that per-chapter match is more precise than a whole-volume one.
      if (!ch || PACKAGED_STATES.has(ch.state)) continue;
      if (!existsSync(sg.filePath)) continue;
      setChapterState(sg.chapterId, 'imported', { cbz_path: sg.filePath, calculated: ch.calculated || 0, language: series.language || 'en' });
      ch.state = 'imported'; // reflect locally so a later dir/suggestion skips it
      applied++;
    }
  }

  return { applied, matchedFiles, totalFiles, dirs };
}
