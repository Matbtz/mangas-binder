import { readdirSync, existsSync, rmSync, statSync } from 'fs';
import path from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';

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
import { readZipDirectory } from './zip-read.js';
import { config } from './config.js';
import { listSeries, getSeries, listChaptersForSeries, setChapterState, upsertChapter } from './repo.js';
import { sanitize } from './library.js';
import { logHistory } from './db.js';
import { getSetting } from './settings.js';

/**
 * Reconcile the on-disk Tome library with the database: find CBZs that already
 * exist, figure out which series/volume/chapters they represent, and mark those
 * chapters as `imported` so we never re-download or re-package them.
 *
 * The *provider/consensus* volume is authoritative — a CBZ's own volume label is
 * only adopted for a chapter that has no volume yet. This is deliberate: a CBZ
 * built from an earlier, mis-estimated volume structure must not re-stamp its
 * stale boundaries back onto a series that a wipe + refresh just re-resolved
 * correctly (the real "Pet" bug — a v03/v05 file re-poisoning chapters 62/63
 * every scan). Files are still matched by chapter membership so nothing is
 * re-downloaded; only the volume *number* now flows provider→file, not file→DB.
 * (The physical CBZs can then be re-grouped to the corrected volumes via a force
 * repackage — packageCompleteVolumes rebuilds them from the same on-disk pages.)
 *
 * Works precisely on CBZs mangas-binder produced (chapter membership is encoded
 * in the page names, e.g. `ch0012_p003.jpg`). Foreign CBZs are matched at the
 * series/volume level but can't be reconciled per-chapter (no chapter list).
 */

const CBZ_PAGE_RE = /^ch(\d+(?:\.\d+)?)_p\d+/i;
// Long form: "Vol. 07", "Volume 7", "Tome 3". Strips leading zeros.
const FILENAME_VOL_RE = /\b(?:vol(?:ume)?|tome)\.?\s*0*(\d+(?:\.\d+)?)/i;
// Short form: "v07", "v101" — common for downloaded manga/comics.
const FILENAME_SHORT_VOL_RE = /\bv(\d{1,4}(?:\.\d+)?)\b/i;
// Issue number for comics: "#10", "# 10", "#010"
const FILENAME_ISSUE_RE = /#\s*0*(\d+(?:\.\d+)?)\b/;

// A version tag is a small revision counter (v2, v3…), almost never above this.
// A "v84" is a volume; scanlators don't put out an 84th revision of a chapter.
const MAX_VERSION_TAG = 4;

/**
 * Extract a volume number from a file/folder name, resolving the ambiguity of
 * the short "vNN" form.
 *
 * A `vNN` marker means *volume* by default — this is the whole point of the
 * check, and real libraries lean on it heavily ("ONE PIECE 1 v84.cbz",
 * "ONE PIECE 3 v87.cbz" are volumes 84 and 87; the leading number is a
 * collection/reading-order index, NOT a chapter). Getting this wrong is what
 * links chapter 3 to a file that is actually volume 87.
 *
 * The one competing meaning is the scanlation *version* tag: "One Piece 985
 * v2.cbz" / "Bleach 001 (v2).cbz" is chapter 985/1 revision 2. That form is
 * recognisable — the `vNN` is a small revision number (≤ MAX_VERSION_TAG) and
 * sits next to a larger companion number that is the real chapter. Only then
 * do we yield null so the caller matches by chapter instead. Long form
 * ("Vol. 07"/"Tome 3") and the comic issue form ("#10 v10") are handled up
 * front and are never ambiguous.
 */
function volumeFromName(name) {
  const volMatch = name.match(FILENAME_VOL_RE);
  if (volMatch) return String(parseFloat(volMatch[1]));
  if (FILENAME_ISSUE_RE.test(name)) return null; // "#10 v10" — vN is a version tag
  const short = name.match(FILENAME_SHORT_VOL_RE);
  if (!short) return null;
  const vNum = parseFloat(short[1]);

  // Only a *small* vNN can be a version tag; a large one is unambiguously a
  // volume regardless of any other number present ("... 1 v84" → volume 84).
  if (vNum <= MAX_VERSION_TAG && companionChapters(name, vNum).length) return null;
  return String(vNum);
}

/**
 * Standalone numbers in a name that are larger than the vNN revision `vNum` —
 * i.e. the real chapter numbers a version tag sits beside ("985 v2" → [985]).
 * The vNN token itself and parenthesised years are excluded, since neither is
 * a chapter/volume number.
 */
function companionChapters(name, vNum) {
  const rest = name.replace(FILENAME_SHORT_VOL_RE, ' ').replace(/\((?:19|20)\d{2}\)/g, ' ');
  return [...rest.matchAll(/(?:^|[^\w.])0*(\d{1,4}(?:\.\d+)?)(?![\w.])/g)]
    .map(m => parseFloat(m[1]))
    .filter(n => n > vNum);
}

/**
 * For a name volumeFromName() rejected as a version-tagged chapter
 * ("One Piece 985 v2.cbz" → chapter 985), return that chapter number, else
 * null. Kept in lockstep with volumeFromName's version-tag rule so exactly one
 * of the two ever claims a given name — a file is either a volume or a
 * (version-tagged) chapter, never both.
 */
function versionTaggedChapter(name) {
  if (FILENAME_VOL_RE.test(name) || FILENAME_ISSUE_RE.test(name)) return null;
  const short = name.match(FILENAME_SHORT_VOL_RE);
  if (!short) return null;
  const vNum = parseFloat(short[1]);
  if (vNum > MAX_VERSION_TAG) return null;
  const chapters = companionChapters(name, vNum);
  return chapters.length ? String(Math.max(...chapters)) : null;
}
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

export async function isEpubArchive(filePath) {
  if (filePath.toLowerCase().endsWith('.epub')) return true;
  return (await readCbzInfo(filePath)).isEpub;
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

// Parsed-CBZ cache keyed by path, validated by (mtime, size). A library scan
// re-reads the same files repeatedly (Library tab renders, scheduler, per-series
// scans); over a NAS even the small central-directory read adds up, so unchanged
// files are served from memory. Bounded to avoid unbounded growth.
const cbzInfoCache = new Map(); // path -> { mtimeMs, size, info }
const CBZ_CACHE_MAX = 5000;

/** Read just the entry names + ComicInfo.xml, without loading the archive body. */
async function readArchiveBits(filePath) {
  try {
    const { names, entryData } = await readZipDirectory(filePath, {
      wantEntry: (n) => n.toLowerCase().endsWith('comicinfo.xml'),
    });
    return { names, xml: entryData ? entryData.toString('utf-8') : null };
  } catch {
    // Rare archives (zip64 / unusual compression): fall back to the full reader.
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const comic = entries.find(e => e.entryName.toLowerCase().endsWith('comicinfo.xml'));
    return {
      names: entries.map(e => e.entryName),
      xml: comic ? comic.getData().toString('utf-8') : null,
    };
  }
}

/**
 * Read identity + chapter membership from a CBZ. Result is cached by file
 * (mtime, size) so repeat scans are near-instant.
 * @returns {Promise<{ series, mangadexId, volume, chapters: string[] }>}
 */
export async function readCbzInfo(filePath) {
  let st = null;
  try { st = statSync(filePath); } catch { /* gone/unreadable — parse anyway */ }
  if (st) {
    const hit = cbzInfoCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  }

  let series = null, mangadexId = null, comicvineId = null, publisher = null, genre = null, manga = null, chapters = [];
  let isEpub = filePath.toLowerCase().endsWith('.epub');
  let error = null;
  let pageCount = 0;

  if (st && st.size > 2 * 1024 * 1024 * 1024) {
    error = `File size (${st.size}) is greater than 2 GiB`;
  } else {
    try {
      const { names, xml } = await readArchiveBits(filePath);
      if (!isEpub) {
        isEpub = names.some(n => {
          const l = n.toLowerCase();
          return l === 'meta-inf/container.xml' || l === 'mimetype';
        });
      }
      if (xml) {
        series = tagText(xml, 'Series');
        publisher = tagText(xml, 'Publisher');
        genre = tagText(xml, 'Genre');
        manga = tagText(xml, 'Manga');
        const web = tagText(xml, 'Web');
        mangadexId = web?.match(WEB_ID_RE)?.[1] || null;
        comicvineId = web?.match(COMICVINE_ID_RE)?.[1] || null;
      }
      const found = new Set();
      for (const n of names) {
        const m = path.basename(n).match(CBZ_PAGE_RE);
        if (m) found.add(String(parseFloat(m[1])));
        const ext = path.extname(n).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          pageCount++;
        }
      }
      chapters = [...found];
    } catch (err) {
      error = err.message || String(err);
    }
  }

  const base = path.basename(filePath);
  const issueMatch = base.match(FILENAME_ISSUE_RE);
  const issueNum = issueMatch ? String(parseFloat(issueMatch[1])) : null;
  // volumeFromName handles both the long "Vol. 07" form and the ambiguous
  // short "v85" form (version tags like "Series 985 v2" yield no volume).
  const volume = volumeFromName(base);
  const hasSeriesTag = !!series;
  if (!series) series = base.replace(/\.(cbz|epub)$/i, '');
  const info = { series, hasSeriesTag, mangadexId, comicvineId, publisher, genre, manga, volume, issueNum, chapters, isEpub, pageCount, error };

  if (st) {
    if (cbzInfoCache.size >= CBZ_CACHE_MAX) cbzInfoCache.clear();
    cbzInfoCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, info });
  }
  return info;
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
 * @param {{ seriesId?: number, force?: boolean }} opts
 *   `seriesId` limits reconciliation to one series; `force` bypasses the cache.
 * @returns {Promise<{ files, matchedFiles, markedChapters, perSeries, untracked }>}
 */

// A full library scan reads the (NAS-backed) library and is the single most
// expensive thing the server does. The Library tab fires it on every render via
// /library/untracked, the scheduler runs it each cycle, and a follow can trigger
// it too — so we (a) coalesce concurrent full scans onto one in-flight run and
// (b) serve a recent result from cache, instead of re-walking the NAS each time.
let _fullScanInFlight = null;
let _fullScanCache = { ts: 0, result: null };
const FULL_SCAN_TTL_MS = 30_000;

export function scanLibrary({ seriesId, force = false } = {}) {
  // Per-series scans are cheap and explicit (a single CBZ tree) — run directly.
  if (seriesId != null) return _scanLibrary({ seriesId });

  if (!force && _fullScanCache.result && Date.now() - _fullScanCache.ts < FULL_SCAN_TTL_MS) {
    return Promise.resolve(_fullScanCache.result);
  }
  if (_fullScanInFlight) return _fullScanInFlight;
  _fullScanInFlight = (async () => {
    try {
      const result = await _scanLibrary({});
      _fullScanCache = { ts: Date.now(), result };
      return result;
    } finally {
      _fullScanInFlight = null;
    }
  })();
  return _fullScanInFlight;
}

async function _scanLibrary({ seriesId } = {}) {
  const all = listSeries();

  // The provider-specific id a CBZ would carry to identify this series.
  const providerKeys = (s) => {
    const keys = [`title:${sanitize(s.title).toLowerCase()}`];
    // Also add a year-stripped variant so "Series (2024)" matches a folder named "Series"
    const noYear = s.title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (noYear !== s.title) keys.push(`title:${sanitize(noYear).toLowerCase()}`);
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
  // For a single-series scan, only walk that series' own subtree(s) instead of
  // the whole (NAS-backed) library: the binder writes under a folder named after
  // the title, plus any linked folder_path. Full scans still walk everything.
  let scanRoots = scanDirs;
  if (seriesId) {
    const target = targets[0];
    const titleKey = target ? sanitize(target.title).toLowerCase() : null;
    const roots = new Set();
    for (const scanDir of scanDirs) {
      if (!existsSync(scanDir)) continue;
      for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
        if (entry.isDirectory() && sanitize(entry.name).toLowerCase() === titleKey) {
          roots.add(path.join(scanDir, entry.name));
        }
      }
    }
    const customDir = target?.folder_path || target?.folderPath;
    if (customDir && existsSync(customDir)) roots.add(customDir);
    scanRoots = [...roots];
  }
  const files = [...new Set(scanRoots.flatMap(d => walkCbz(d)))];
  const chaptersBySeries = new Map(); // seriesId -> Map(number -> row)
  let matchedFiles = 0, markedChapters = 0;
  const perSeries = {};
  // Series whose on-disk CBZ groups a chapter under a different volume than the
  // (now-authoritative) provider volume — the file is physically stale and can be
  // re-grouped to the corrected volumes by a force repackage. Reported so the
  // caller can trigger that rematch (packageCompleteVolumes rebuilds each volume
  // from the very same on-disk pages).
  const driftedSeries = new Set();

  const outputDir = getSetting('outputDir') || config.outputDir;
  const outputDirNormalized = path.normalize(outputDir).toLowerCase();

  let scanned = 0;
  for (const file of files) {
    // Yield periodically so a large library scan never monopolises the event
    // loop — the server stays responsive to requests while it runs.
    if ((++scanned & 31) === 0) await yieldToLoop();
    const info = await readCbzInfo(file);
    const keys = fileKeys(info);
    let match = null;
    for (const k of keys) { if (byKey.has(k)) { match = byKey.get(k); break; } }
    let usedDirFallback = false;
    if (!match) {
      // Foreign CBZs stored in a series-named folder (e.g. "Dandadan/07.cbz") often
      // lack a <Series> tag, so their title key is the filename, not the series name.
      // Use the parent directory name as a fallback series identifier.
      const dirKey = `title:${sanitize(path.basename(path.dirname(file))).toLowerCase()}`;
      if (byKey.has(dirKey)) { match = byKey.get(dirKey); usedDirFallback = true; }
    }
    if (!match) continue;
    if (seriesId && match.id !== seriesId) continue;
    matchedFiles++;

    const isBinderyFile = path.normalize(file).toLowerCase().startsWith(outputDirNormalized);
    const targetState = isBinderyFile ? 'bindery' : 'imported';

    if (!chaptersBySeries.has(match.id)) {
      chaptersBySeries.set(match.id, new Map(listChaptersForSeries(match.id).map(c => [String(parseFloat(c.number)), c])));
    }
    const index = chaptersBySeries.get(match.id);
    let matchedCount = 0;
    for (const num of info.chapters) {
      const row = index.get(String(parseFloat(num)));
      if (!row || row.state === 'imported' || row.state === targetState) continue;
      // Adopt the file's volume label ONLY when the chapter has no volume of its
      // own — the provider/consensus volume is authoritative (see module header),
      // so a stale CBZ can't overwrite a freshly-resolved boundary. A chapter that
      // already carries a volume keeps it (and its calculated/estimate flag).
      const hasVolume = row.volume != null && row.volume !== '';
      const extra = { cbz_path: file, language: match.language || 'en' };
      if (!hasVolume && info.volume) { extra.volume = info.volume; extra.calculated = 0; }
      else if (hasVolume && info.volume && String(parseFloat(info.volume)) !== String(parseFloat(row.volume))) {
        driftedSeries.add(match.id); // file groups this chapter under a stale volume
      }
      setChapterState(row.id, targetState, extra);
      row.state = targetState;
      if (!hasVolume && info.volume) row.volume = info.volume;
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
        if (row.state !== 'imported' && row.state !== targetState && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === String(parseFloat(info.volume))) {
          setChapterState(row.id, targetState, { cbz_path: file, calculated: row.calculated || 0, language: match.language || 'en' });
          row.state = targetState;
          markedChapters++;
          matchedCount++;
          perSeries[match.title] = (perSeries[match.title] || 0) + 1;
        }
      }
    }
    // Issue-number matching for comics: "#10 v10.cbz" → chapter number "10".
    // Tried before bare-number fallback so explicit #N wins over ambiguous bare digit.
    if (matchedCount === 0 && info.issueNum) {
      const row = index.get(info.issueNum);
      if (row && row.state !== 'imported' && row.state !== targetState) {
        setChapterState(row.id, targetState, { cbz_path: file, calculated: row.calculated || 0, language: match.language || 'en' });
        row.state = targetState;
        markedChapters++;
        matchedCount++;
        perSeries[match.title] = (perSeries[match.title] || 0) + 1;
      }
    }
    // When matching was via directory fallback and no "Vol N" keyword appears in the
    // filename, resolve the filename number.
    if (matchedCount === 0 && !info.volume && usedDirFallback) {
      const base = path.basename(file).replace(/\.(cbz|epub)$/i, '');
      // A version-tagged chapter ("One Piece 985 v2.cbz") is matched by its
      // chapter number — never read the big number as a volume, and never let
      // the small "v2" become a volume either.
      const verCh = versionTaggedChapter(base);
      if (verCh) {
        const row = index.get(String(parseFloat(verCh)));
        if (row && row.state !== 'imported' && row.state !== targetState) {
          setChapterState(row.id, targetState, { cbz_path: file, calculated: row.calculated || 0, language: match.language || 'en' });
          row.state = targetState;
          markedChapters++;
          matchedCount++;
          perSeries[match.title] = (perSeries[match.title] || 0) + 1;
        }
      } else {
        // A bare number with no vNN token at all ("Dandadan/07.cbz",
        // "Dandadan_07.cbz") is a volume indicator.
        const bareVol = !FILENAME_SHORT_VOL_RE.test(base) && base.match(/(?:^|[-_\s])0*(\d{1,3}(?:\.\d+)?)(?:$|[-_\s])/);
        if (bareVol) {
          const vNum = String(parseFloat(bareVol[1]));
          for (const row of index.values()) {
            if (row.state !== 'imported' && row.state !== targetState && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === vNum) {
              setChapterState(row.id, targetState, { cbz_path: file, calculated: row.calculated || 0, language: match.language || 'en' });
              row.state = targetState;
              markedChapters++;
              perSeries[match.title] = (perSeries[match.title] || 0) + 1;
            }
          }
        }
      }
    }
  }

  // --- Folder-based reconciliation: chapter image directories ---
  const seriesByTitle = new Map();
  for (const s of targets) {
    seriesByTitle.set(sanitize(s.title).toLowerCase(), s);
    const noYear = s.title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (noYear !== s.title) seriesByTitle.set(sanitize(noYear).toLowerCase(), s);
  }

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
        const chPath = path.join(seriesPath, chEntry.name);
        if (!dirHasImages(chPath)) continue;

        const isBinderyFile = path.normalize(chPath).toLowerCase().startsWith(outputDirNormalized);
        const targetState = isBinderyFile ? 'bindery' : 'imported';

        // A volume-named folder ("Vol. 12", "One Piece v85"): mark that
        // volume's chapters owned instead of misreading its number as a
        // chapter number.
        const dirVol = volumeFromName(chEntry.name);
        if (dirVol) {
          for (const row of index.values()) {
            if (row.state !== 'imported' && row.state !== targetState && row.volume != null && row.volume !== '' && String(parseFloat(row.volume)) === dirVol) {
              setChapterState(row.id, targetState, { cbz_path: chPath, calculated: row.calculated || 0, language: match.language || 'en' });
              row.state = targetState;
              markedChapters++;
              matchedFiles++;
              perSeries[match.title] = (perSeries[match.title] || 0) + 1;
            }
          }
          continue;
        }

        const chNum = chNumFromDir(chEntry.name);
        if (!chNum) continue;
        const row = index.get(String(parseFloat(chNum)));
        if (!row || row.state === 'imported' || row.state === targetState) continue;
        setChapterState(row.id, targetState, { cbz_path: chPath, calculated: 0, language: match.language || 'en' });
        row.state = targetState;
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
      const isBinderyFile = p && path.normalize(p).toLowerCase().startsWith(outputDirNormalized);
      const targetState = isBinderyFile ? 'bindery' : 'imported';
      let row = index.get(key);
      if (!row) {
        upsertChapter(match.id, {
          provider: match.provider || 'local',
          number: key,
          volume: volStr ? String(parseFloat(volStr)) : null,
          title: numStr.startsWith('Vol.') ? `Volume ${volStr}` : `Chapter ${key}`,
          language: match.language || 'en'
        }, targetState);
        row = listChaptersForSeries(match.id).find(c => c.number === key);
        if (row) {
          setChapterState(row.id, targetState, { cbz_path: p, calculated: 0 });
          index.set(key, row);
          markedChapters++;
        }
        return true;
      }
      if (row.state !== 'imported' && row.state !== targetState) {
        setChapterState(row.id, targetState, { cbz_path: p, calculated: row.calculated || 0, language: match.language || 'en', ...(volStr ? { volume: String(parseFloat(volStr)) } : {}) });
        row.state = targetState;
        markedChapters++;
        return true;
      }
      return false;
    };

    // 1. Scan customDir for CBZ files
    for (const file of walkCbz(customDir)) {
      const info = await readCbzInfo(file);
      const isBinderyFile = path.normalize(file).toLowerCase().startsWith(outputDirNormalized);
      const targetState = isBinderyFile ? 'bindery' : 'imported';
      let matchedCount = 0;
      for (const num of info.chapters) {
        if (ensureCh(num, info.volume, file)) matchedCount++;
      }
      if (matchedCount === 0 && info.volume) {
        for (const row of index.values()) {
          if (row.state !== 'imported' && row.state !== targetState && String(parseFloat(row.volume)) === String(parseFloat(info.volume))) {
            setChapterState(row.id, targetState, { cbz_path: file, calculated: 0 });
            row.state = targetState;
            markedChapters++;
            matchedCount++;
          }
        }
      }
      if (matchedCount === 0) {
        const base = path.basename(file, '.cbz');
        if (info.volume) {
          // The filename names a volume and the by-volume row matching above
          // found nothing (e.g. no chapters assigned to that volume yet).
          // Record an owned-volume placeholder — and never fall through to
          // chapter-number matching, which would link a volume file to the
          // same-numbered chapter ("ONE PIECE 85 v85.cbz" marking chapter 85
          // as owned instead of volume 85).
          const vNum = String(parseFloat(info.volume));
          if (ensureCh(`Vol.${vNum}`, vNum, file)) matchedCount++;
        } else {
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
          const isBinderyFile = path.normalize(sub).toLowerCase().startsWith(outputDirNormalized);
          const targetState = isBinderyFile ? 'bindery' : 'imported';

          // Same volume-vs-chapter disambiguation as CBZ files: a folder named
          // for a volume (long or short form) must never fall through to
          // chapter-number matching.
          const dirVol = volumeFromName(e.name);
          if (dirVol) {
            const vNum = String(parseFloat(dirVol));
            let vmatched = 0;
            for (const row of index.values()) {
              if (row.state !== 'imported' && row.state !== targetState && (row.volume != null && row.volume !== '') && String(parseFloat(row.volume)) === vNum) {
                setChapterState(row.id, targetState, { cbz_path: sub, language: match.language || 'en' });
                row.state = targetState;
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

  // --- Reconciliation: prune owned chapters whose files no longer exist on disk ---
  let prunedChapters = 0;
  const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
  for (const match of targets) {
    const chapters = listChaptersForSeries(match.id);
    const resetState = match.monitor_mode === 'none' ? 'skipped' : 'wanted';
    for (const c of chapters) {
      if (LOCAL_STATES.has(c.state) || c.cbz_path != null) {
        const p = c.cbz_path || c.staging_path;
        if (p && !p.startsWith('included_in_vol_') && !existsSync(p)) {
          let foundInBooks = false;
          const outputDir = getSetting('outputDir') || config.outputDir;
          const outputDirNormalized = path.normalize(outputDir).toLowerCase();
          const normP = path.normalize(p).toLowerCase();

          if (normP.startsWith(outputDirNormalized)) {
            const relPath = path.relative(outputDir, p);
            for (const scanDir of scanDirs) {
              const scanDirNorm = path.normalize(scanDir).toLowerCase();
              if (scanDirNorm === outputDirNormalized) continue; // skip bindery itself
              const candidatePath = path.join(scanDir, relPath);
              if (existsSync(candidatePath)) {
                setChapterState(c.id, 'imported', { cbz_path: candidatePath });
                foundInBooks = true;
                break;
              }
            }
          }

          if (!foundInBooks) {
            setChapterState(c.id, resetState, { cbz_path: null, staging_path: null });
            prunedChapters++;
          }
        } else if (!p && LOCAL_STATES.has(c.state)) {
          setChapterState(c.id, resetState, { cbz_path: null, staging_path: null });
          prunedChapters++;
        }
      }
    }
  }

  if (prunedChapters > 0) {
    logHistory('library.scanned', { message: `pruned ${prunedChapters} missing chapter record(s) from database` });
  }

  // --- Untracked detection: directory-based ---
  // Each immediate subdir is a series candidate. CBZs inside are read only to
  // extract a provider ID and a consensus title (when all CBZs share one series
  // name, prefer that over the folder name — e.g. a generic "cbz" output folder
  // becomes "Dandadan"). Entries with the same resolved title are merged so a
  // finished-CBZ folder and a raw-chapters folder don't produce duplicates.
  const untrackedMap = new Map(); // key  -> entry
  const byTitle    = new Map(); // sanitized title -> key

  // Untracked discovery only makes sense for a full scan; a per-series scan
  // skips it entirely (and avoids re-walking the whole library).
  for (const scanDir of (seriesId ? [] : scanDirs)) {
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
        const sampleFiles = bookFiles.slice(0, 3);
        for (const f of sampleFiles) {
          const info = await readCbzInfo(f);
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
        const info = await readCbzInfo(fullPath);
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

  const msgParts = [];
  if (markedChapters > 0) msgParts.push(`Marked ${markedChapters} chapter(s) as owned.`);
  if (prunedChapters > 0) msgParts.push(`Pruned ${prunedChapters} missing chapter(s) from DB.`);
  if (msgParts.length > 0) {
    import('./notify.js').then(m => m.notifyScan(msgParts.join(' ')));
  }

  return { files: files.length, matchedFiles, markedChapters, perSeries, untracked, driftedSeries: [...driftedSeries] };
}
