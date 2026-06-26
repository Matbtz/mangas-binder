import { readdirSync, existsSync, rmSync } from 'fs';
import path from 'path';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);
const FOLDER_CH_RE = /^(?:ch(?:apter)?\.?\s*)(\d+(?:\.\d+)?)/i;
const FOLDER_NUM_RE = /^(\d+(?:\.\d+)?)/;

function dirHasImages(dir) {
  try { return readdirSync(dir).some(f => IMAGE_EXTS.has(path.extname(f).toLowerCase())); }
  catch { return false; }
}

function chNumFromDir(name) {
  const m = name.match(/(?:^|\b)(?:ch(?:apter)?\.?\s*|#\s*)(\d+(?:\.\d+)?)\b/i) || name.match(/(?:^|\b)(\d+(?:\.\d+)?)\b/);
  return m ? String(parseFloat(m[1])) : null;
}
import AdmZip from 'adm-zip';
import { config } from './config.js';
import { listSeries, getSeries, listChaptersForSeries, setChapterState, upsertChapter } from './repo.js';
import { sanitize } from './library.js';
import { resolveVolumes } from './mapping.js';
import { logHistory } from './db.js';
import { getSetting } from './settings.js';

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
const FILENAME_VOL_RE = /\b(?:vol|tome)\.?\s*0*(\d+(?:\.\d+)?)/i;
const WEB_ID_RE = /mangadex\.org\/title\/([0-9a-f-]{36})/i;
const COMICVINE_ID_RE = /comicvine\.gamespot\.com\/volume\/4050-(\d+)/i;

function walkCbz(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkCbz(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.cbz')) out.push(full);
  }
  return out;
}

export function isEpubArchive(filePath) {
  if (filePath.toLowerCase().endsWith('.epub')) return true;
  try {
    const zip = new AdmZip(filePath);
    const names = zip.getEntries().map(e => e.entryName.toLowerCase());
    return names.some(n => n === 'meta-inf/container.xml' || n === 'mimetype');
  } catch {
    return false;
  }
}

function walkUntrackedFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkUntrackedFiles(full, out);
    else if (e.isFile() && (e.name.toLowerCase().endsWith('.cbz') || e.name.toLowerCase().endsWith('.epub'))) out.push(full);
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
  let series = null, mangadexId = null, comicvineId = null, publisher = null, genre = null, manga = null, chapters = [];
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const comic = entries.find(e => e.entryName.toLowerCase().endsWith('comicinfo.xml'));
    if (comic) {
      const xml = comic.getData().toString('utf-8');
      series = tagText(xml, 'Series');
      publisher = tagText(xml, 'Publisher');
      genre = tagText(xml, 'Genre');
      manga = tagText(xml, 'Manga');
      const web = tagText(xml, 'Web');
      mangadexId = web?.match(WEB_ID_RE)?.[1] || null;
      comicvineId = web?.match(COMICVINE_ID_RE)?.[1] || null;
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
  const hasSeriesTag = !!series;
  if (!series) series = path.basename(filePath).replace(/\.(cbz|epub)$/i, '');
  return { series, hasSeriesTag, mangadexId, comicvineId, publisher, genre, manga, volume, chapters, isEpub: isEpubArchive(filePath) };
}

/** The provider id encoded in a CBZ that identifies a given followed series. */
function providerIdFor(series, info) {
  if (series.provider === 'mangadex') return info.mangadexId;
  if (series.provider === 'comicvine') return info.comicvineId;
  return null;
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

  // The provider-specific id a CBZ would carry to identify this series.
  const providerKeys = (s) => {
    const keys = [`title:${sanitize(s.title).toLowerCase()}`];
    keys.push(`${s.provider}:${s.provider_series_id}`);
    return keys;
  };
  // The keys a scanned file could match against (it carries one web id + a title).
  const fileKeys = (info) => {
    const keys = [`title:${sanitize(info.series).toLowerCase()}`];
    if (info.mangadexId) keys.push(`mangadex:${info.mangadexId}`);
    if (info.comicvineId) keys.push(`comicvine:${info.comicvineId}`);
    return keys;
  };

  // Build lookup tables for all tracked series (not just the target) so we can
  // exclude them from the untracked suggestions.
  const allByKey = new Map();
  for (const s of all) for (const k of providerKeys(s)) allByKey.set(k, s);

  const targets = seriesId ? [getSeries(seriesId)].filter(Boolean) : all;
  const byKey = new Map();
  for (const s of targets) for (const k of providerKeys(s)) byKey.set(k, s);

  const dirsSetting = getSetting('libraryScanDirs', '');
  const scanDirs = dirsSetting
    ? dirsSetting.split(',').map(d => d.trim()).filter(Boolean)
        .map(p => path.isAbsolute(p) ? p : path.resolve(process.cwd(), p))
    : config.libraryScanDirs;
  // --- Reconciliation: mark already-owned CBZ chapters as imported ---
  const files = [...new Set(scanDirs.flatMap(d => walkCbz(d)))];
  const chaptersBySeries = new Map(); // seriesId -> Map(number -> row)
  let matchedFiles = 0, markedChapters = 0;
  const perSeries = {};

  for (const file of files) {
    const info = readCbzInfo(file);
    const keys = fileKeys(info);
    let match = null;
    for (const k of keys) { if (byKey.has(k)) { match = byKey.get(k); break; } }
    if (!match) continue;
    if (seriesId && match.id !== seriesId) continue;
    matchedFiles++;

    if (!chaptersBySeries.has(match.id)) {
      chaptersBySeries.set(match.id, new Map(listChaptersForSeries(match.id).map(c => [String(parseFloat(c.number)), c])));
    }
    const index = chaptersBySeries.get(match.id);
    let matchedCount = 0;
    for (const num of info.chapters) {
      const row = index.get(String(parseFloat(num)));
      if (!row || row.state === 'imported') continue;
      setChapterState(row.id, 'imported', {
        cbz_path: file,
        calculated: 0,
        language: match.language || 'en',
        ...(info.volume ? { volume: info.volume } : {}),
      });
      row.state = 'imported';
      markedChapters++;
      matchedCount++;
      perSeries[match.title] = (perSeries[match.title] || 0) + 1;

      if (!getSetting('keepLoosePages', false)) {
        const sDir = path.join(getSetting('stagingDir', config.stagingDir), String(match.id), `ch${row.number}`);
        rmSync(sDir, { recursive: true, force: true });
      }
    }
    if (matchedCount === 0 && info.volume) {
      for (const row of index.values()) {
        if (row.state !== 'imported' && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === String(parseFloat(info.volume))) {
          setChapterState(row.id, 'imported', { cbz_path: file, calculated: row.calculated || 0, language: match.language || 'en' });
          row.state = 'imported';
          markedChapters++;
          perSeries[match.title] = (perSeries[match.title] || 0) + 1;
        }
      }
    }
  }

  // --- Folder-based reconciliation: chapter image directories ---
  const seriesByTitle = new Map();
  for (const s of targets) seriesByTitle.set(sanitize(s.title).toLowerCase(), s);

  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) continue;
    for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = seriesByTitle.get(sanitize(entry.name).toLowerCase());
      if (!match) continue;
      if (seriesId && match.id !== seriesId) continue;

      if (!chaptersBySeries.has(match.id)) {
        chaptersBySeries.set(match.id, new Map(
          listChaptersForSeries(match.id).map(c => [String(parseFloat(c.number)), c])
        ));
      }
      const index = chaptersBySeries.get(match.id);
      const seriesPath = path.join(scanDir, entry.name);

      for (const chEntry of readdirSync(seriesPath, { withFileTypes: true })) {
        if (!chEntry.isDirectory()) continue;
        const chNum = chNumFromDir(chEntry.name);
        if (!chNum) continue;
        const chPath = path.join(seriesPath, chEntry.name);
        if (!dirHasImages(chPath)) continue;

        const row = index.get(String(parseFloat(chNum)));
        if (!row || row.state === 'imported') continue;
        setChapterState(row.id, 'imported', { cbz_path: chPath, calculated: 0, language: match.language || 'en' });
        row.state = 'imported';
        markedChapters++;
        matchedFiles++;
        perSeries[match.title] = (perSeries[match.title] || 0) + 1;
      }
    }
  }

  // --- Dedicated reconciliation for linked local folders ---
  for (const match of targets) {
    const customDir = match.folder_path || match.folderPath;
    if (!customDir || !existsSync(customDir)) continue;

    if (!chaptersBySeries.has(match.id)) {
      chaptersBySeries.set(match.id, new Map(listChaptersForSeries(match.id).map(c => [String(parseFloat(c.number)), c])));
    }
    const index = chaptersBySeries.get(match.id);

    const ensureCh = (numStr, volStr, p) => {
      if (!numStr) return false;
      const key = numStr.startsWith('Vol.') ? numStr : String(parseFloat(numStr));
      if (!numStr.startsWith('Vol.') && Number.isNaN(parseFloat(key))) return false;
      let row = index.get(key);
      if (!row) {
        upsertChapter(match.id, {
          provider: match.provider || 'local',
          number: key,
          volume: volStr ? String(parseFloat(volStr)) : null,
          title: numStr.startsWith('Vol.') ? `Volume ${volStr}` : `Chapter ${key}`,
          language: match.language || 'en'
        }, 'imported');
        row = listChaptersForSeries(match.id).find(c => c.number === key);
        if (row) {
          setChapterState(row.id, 'imported', { cbz_path: p, calculated: 0 });
          index.set(key, row);
          markedChapters++;
        }
        return true;
      }
      if (row.state !== 'imported') {
        setChapterState(row.id, 'imported', { cbz_path: p, calculated: row.calculated || 0, language: match.language || 'en', ...(volStr ? { volume: String(parseFloat(volStr)) } : {}) });
        row.state = 'imported';
        markedChapters++;
        return true;
      }
      return false;
    };

    // 1. Scan customDir for CBZ files
    for (const file of walkCbz(customDir)) {
      const info = readCbzInfo(file);
      let matchedCount = 0;
      for (const num of info.chapters) {
        if (ensureCh(num, info.volume, file)) matchedCount++;
      }
      if (matchedCount === 0 && info.volume) {
        for (const row of index.values()) {
          if (row.state !== 'imported' && String(parseFloat(row.volume)) === String(parseFloat(info.volume))) {
            setChapterState(row.id, 'imported', { cbz_path: file, calculated: 0 });
            row.state = 'imported';
            markedChapters++;
            matchedCount++;
          }
        }
      }
      if (matchedCount === 0) {
        const base = path.basename(file, '.cbz');
        const volM = base.match(/(?:^|\b)(?:vol(?:ume)?\.?\s*|tome\s*)0*(\d+(?:\.\d+)?)\b/i);
        if (volM) {
          const vNum = String(parseFloat(volM[1]));
          for (const row of index.values()) {
            if (row.state !== 'imported' && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === vNum) {
              setChapterState(row.id, 'imported', { cbz_path: file, calculated: row.calculated });
              row.state = 'imported';
              markedChapters++;
              matchedCount++;
            }
          }
          if (matchedCount === 0) {
            if (ensureCh(`Vol.${vNum}`, vNum, file)) matchedCount++;
          }
        }
        if (matchedCount === 0) {
          const chNum = chNumFromDir(base);
          if (chNum) {
            if (ensureCh(chNum, null, file)) matchedCount++;
          }
        }
      }
      matchedFiles++;
      perSeries[match.title] = (perSeries[match.title] || 0) + 1;
    }

    // 2. Scan customDir for chapter image directories
    const walkSubDirs = (dir) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        if (dirHasImages(sub)) {
          const volM = e.name.match(/(?:^|\b)(?:vol(?:ume)?\.?\s*|tome\s*)0*(\d+(?:\.\d+)?)\b/i);
          if (volM) {
            const vNum = String(parseFloat(volM[1]));
            let vmatched = 0;
            for (const row of index.values()) {
              if (row.state !== 'imported' && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === vNum) {
                setChapterState(row.id, 'imported', { cbz_path: sub, language: match.language || 'en' });
                row.state = 'imported';
                markedChapters++;
                matchedFiles++;
                vmatched++;
              }
            }
            if (vmatched === 0) {
              if (ensureCh(`Vol.${vNum}`, vNum, sub)) matchedFiles++;
            }
          } else {
            const chNum = chNumFromDir(e.name);
            if (chNum) {
              if (ensureCh(chNum, null, sub)) matchedFiles++;
            }
          }
        } else {
          walkSubDirs(sub);
        }
      }
    };
    walkSubDirs(customDir);
  }

  if (markedChapters > 0) {
    logHistory('library.scanned', { message: `marked ${markedChapters} owned chapter(s) across ${matchedFiles} file(s)` });
  }

  // --- Untracked detection: directory-based ---
  // Each immediate subdir is a series candidate. CBZs inside are read only to
  // extract a provider ID and a consensus title (when all CBZs share one series
  // name, prefer that over the folder name — e.g. a generic "cbz" output folder
  // becomes "Dandadan"). Entries with the same resolved title are merged so a
  // finished-CBZ folder and a raw-chapters folder don't produce duplicates.
  const untrackedMap = new Map(); // key  -> entry
  const byTitle    = new Map(); // sanitized title -> key

  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) continue;
    for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(scanDir, entry.name);

      if (entry.isDirectory()) {
        let mangadexId = null, comicvineId = null, publisher = null, genre = null, manga = null;
        const titleCounts = new Map();
        const bookFiles = walkUntrackedFiles(fullPath);
        if (bookFiles.length === 0) continue;

        let epubCount = 0;
        for (const f of bookFiles) {
          const info = readCbzInfo(f);
          if (!mangadexId && info.mangadexId) mangadexId = info.mangadexId;
          if (!comicvineId && info.comicvineId) comicvineId = info.comicvineId;
          if (!publisher && info.publisher) publisher = info.publisher;
          if (!genre && info.genre) genre = info.genre;
          if (!manga && info.manga) manga = info.manga;
          if (info.hasSeriesTag && info.series) titleCounts.set(info.series, (titleCounts.get(info.series) || 0) + 1);
          if (info.isEpub) epubCount++;
        }
        const displayTitle = (titleCounts.size > 0) ? [...titleCounts.keys()][0] : entry.name;
        const sanitizedTitle = sanitize(displayTitle).toLowerCase();

        if (allByKey.has(`title:${sanitizedTitle}`)) continue;
        if (mangadexId && allByKey.has(`mangadex:${mangadexId}`)) continue;
        if (comicvineId && allByKey.has(`comicvine:${comicvineId}`)) continue;

        const fileCount = bookFiles.length;
        const isSingleEpub = (fileCount === 1 && epubCount === 1);

        const volumes = new Set();
        for (const f of bookFiles) {
          const m = path.basename(f).match(FILENAME_VOL_RE);
          if (m) volumes.add(String(parseFloat(m[1])));
        }

        const key = mangadexId || comicvineId || sanitizedTitle;

        if (byTitle.has(sanitizedTitle)) {
          const existingKey = byTitle.get(sanitizedTitle);
          const existing = untrackedMap.get(existingKey);
          if (existing) {
            existing.fileCount += fileCount;
            existing.isSingleEpub = false; // merged => >1 file
            for (const v of volumes) existing.volumes.add(v);
            if (!existing.mangadexId && mangadexId) {
              existing.mangadexId = mangadexId;
              if (key !== existingKey) {
                 untrackedMap.delete(existingKey);
                 untrackedMap.set(key, existing);
                 byTitle.set(sanitizedTitle, key);
              }
            }
            if (!existing.comicvineId && comicvineId) existing.comicvineId = comicvineId;
            continue;
          }
        }

        untrackedMap.set(key, { title: displayTitle, mangadexId, comicvineId, publisher, genre, manga, isSingleEpub, volumes, fileCount });
        byTitle.set(sanitizedTitle, key);

      } else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.cbz') || entry.name.toLowerCase().endsWith('.epub'))) {
        const info = readCbzInfo(fullPath);
        const keys = fileKeys(info);
        if (keys.some(k => allByKey.has(k))) continue;

        const key = info.mangadexId || info.comicvineId || sanitize(info.series).toLowerCase();
        if (!untrackedMap.has(key)) {
          untrackedMap.set(key, { title: info.series, mangadexId: info.mangadexId, comicvineId: info.comicvineId, publisher: info.publisher, genre: info.genre, manga: info.manga, isSingleEpub: !!info.isEpub, volumes: new Set(), fileCount: 0 });
          byTitle.set(sanitize(info.series).toLowerCase(), key);
        }
        const e = untrackedMap.get(key);
        if (info.volume) e.volumes.add(info.volume);
        e.fileCount++;
        if (e.fileCount > 1) e.isSingleEpub = false;
      }
    }
  }

  const untracked = [...untrackedMap.values()].map(e => {
    let mediaType = e.comicvineId ? 'comic' : 'manga';
    if (!e.comicvineId) {
      const pub = (e.publisher || '').toLowerCase();
      const g = (e.genre || '').toLowerCase();
      const comicPubs = ['dc comics', 'marvel', 'image', 'dark horse', 'idw', 'dynamite', 'boom', 'vertigo', '2000 ad', 'archie'];
      if (comicPubs.some(p => pub.includes(p)) || g.includes('superhero')) mediaType = 'comic';
    }
    return {
      title: e.title,
      mangadexId: e.mangadexId,
      comicvineId: e.comicvineId,
      mediaType,
      isSingleEpub: !!e.isSingleEpub,
      publisher: e.publisher || null,
      genre: e.genre || null,
      manga: e.manga || null,
      volumes: [...e.volumes].sort((a, b) => parseFloat(a) - parseFloat(b)),
      fileCount: e.fileCount,
    };
  });

  return { files: files.length, matchedFiles, markedChapters, perSeries, untracked };
}
