import { writeFile, mkdir, readdir, rename, rm } from 'fs/promises';
import { open } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { pLimit, fetchRetry, abortError } from './limit.js';
import { config } from '../core/config.js';
import { getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';

function debugLog(event, opts = {}) {
  if (getSetting('debugLogs', false)) {
    logHistory('debug.' + event, opts);
  }
}

const USER_AGENT = 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)';

function pad(n, w = 3) { return String(n).padStart(w, '0'); }

function extFromUrl(url) {
  const clean = url.split('?')[0];
  const ext = path.extname(clean).toLowerCase();
  return /^\.(jpg|jpeg|png|webp|gif|avif)$/.test(ext) ? ext : '.jpg';
}

/**
 * Sniff a buffer's magic bytes to confirm it's really an image. Catches the
 * common failure where a server returns an HTML error/Cloudflare-challenge page
 * (or a `.bin` placeholder) with a 200 status — HakuNeko's known invalid-image
 * bug. Returns true for JPEG/PNG/GIF/WEBP/AVIF/BMP.
 */
export function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  const ascii = buf.toString('ascii', 0, 12);
  // WEBP: "RIFF"...."WEBP"
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return true;
  // AVIF/HEIF: an ISO-BMFF "ftyp" box near the start
  if (ascii.slice(4, 8) === 'ftyp') return true;
  return false;
}


// Returns { w, h } or null. Reads only the first ~24 bytes of the buffer.
export function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: IHDR chunk at offset 16 (4 bytes width, 4 bytes height, big-endian)
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2) marker
  // Structure: FF Cx [len 2B] [precision 1B] [height 2B] [width 2B]
  for (let i = 2; i < Math.min(buf.length - 8, 65536); i++) {
    if (buf[i] === 0xff && (buf[i+1] & 0xf0) === 0xc0 && buf[i+1] !== 0xff) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
  }
  return null;
}

/** Staging directory for a chapter's downloaded pages. */
export function chapterStagingDir(seriesId, number) {
  return path.join(getSetting('stagingDir', config.stagingDir), String(seriesId), `ch${number}`);
}

/**
 * Normalise a getChapterPages result into [{ url, headers }]. Providers may
 * return bare URL strings (the common case) or { url, headers } objects when a
 * source needs per-request headers (e.g. a Referer or cf_clearance Cookie).
 */
function normalizeEntries(pages) {
  return (pages || []).map(p => (typeof p === 'string' ? { url: p, headers: {} } : { url: p.url, headers: p.headers || {} }));
}

/**
 * Fetch a list of page entries into `dir` as 001.ext, 002.ext, …
 * Resumable (existing valid files are skipped), validates that each download is
 * really an image, and merges per-entry headers over the default User-Agent.
 * Shared by the primary and fallback download paths so resume/validation/header
 * behaviour is identical.
 *
 * @param {string} dir
 * @param {Array<{url:string, headers?:object}>} entries
 * @param {{ concurrency?, onProgress?, signal? }} opts
 * @returns {Promise<{ dir, pageCount }>}
 */
// Per-page hard deadline. CDN nodes that accept the connection but never finish
// sending would otherwise block a chapter download slot indefinitely.
const PAGE_TIMEOUT_MS = 45_000;

export async function fetchPagesToStaging(dir, entries, { concurrency = 4, onProgress, signal, seriesId, chapterId } = {}) {
  if (!entries.length) throw new Error('No pages to fetch');
  debugLog('downloader.fetch_start', { seriesId, chapterId, message: `Starting fetch of ${entries.length} pages into staging: ${dir}` });
  await mkdir(dir, { recursive: true });
  const limit = pLimit(concurrency);

  let done = 0;
  onProgress?.(0, entries.length);
  await Promise.all(entries.map((entry, i) => limit(async () => {
    if (signal?.aborted) throw abortError();
    const dest = path.join(dir, `${pad(i + 1)}${extFromUrl(entry.url)}`);
    if (existsSync(dest)) {
      debugLog('downloader.page_skip', { seriesId, chapterId, message: `Skipping page ${i + 1}/${entries.length} (already exists)` });
      onProgress?.(++done, entries.length);
      return;
    }
    const headers = { 'User-Agent': USER_AGENT, ...(entry.headers || {}) };

    // Per-page timeout controller; forward the chapter-level abort so user-cancel
    // still propagates instantly without waiting for the page timer to expire.
    const pageCtrl = new AbortController();
    const pageTimer = setTimeout(() => pageCtrl.abort(), PAGE_TIMEOUT_MS);
    const onParentAbort = () => { clearTimeout(pageTimer); pageCtrl.abort(); };
    signal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      debugLog('downloader.page_fetch_start', { seriesId, chapterId, message: `Fetching page ${i + 1}/${entries.length}: ${entry.url}` });
      const res = await fetchRetry(entry.url, { headers, signal: pageCtrl.signal });
      if (!res.ok) throw new Error(`Page ${i + 1} HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error(`Page ${i + 1} empty`);
      if (!isImageBuffer(buf)) throw new Error(`Page ${i + 1} is not a valid image (got ${buf.length} bytes, likely an error/challenge page)`);
      // Atomic-ish write: temp then rename so a crash never leaves a partial page.
      const tmp = `${dest}.part`;
      await writeFile(tmp, buf);
      await rename(tmp, dest);
      debugLog('downloader.page_fetch_success', { seriesId, chapterId, message: `Successfully saved page ${i + 1}/${entries.length}` });
      onProgress?.(++done, entries.length);
    } catch (err) {
      debugLog('downloader.page_fetch_error', { seriesId, chapterId, message: `Failed page ${i + 1}/${entries.length}: ${err.message || err}` });
      throw err;
    } finally {
      clearTimeout(pageTimer);
      signal?.removeEventListener('abort', onParentAbort);
    }
  })));

  const expectedNames = new Set(entries.map((entry, i) => `${pad(i + 1)}${extFromUrl(entry.url)}`));
  const allFiles = await readdir(dir);
  for (const f of allFiles) {
    if (!f.endsWith('.part') && !expectedNames.has(f)) {
      try { await rm(path.join(dir, f), { force: true }); } catch {}
    }
  }

  const written = (await readdir(dir)).filter(f => !f.endsWith('.part'));
  if (written.length < entries.length) {
    throw new Error(`Downloaded ${written.length}/${entries.length} pages`);
  }
  const { scanQuality, minPageWidth } = await scoreChapterQuality(dir, entries.length);
  return { dir, pageCount: entries.length, scanQuality, minPageWidth };
}

/**
 * Download every page of a chapter into its staging dir as 001.ext, 002.ext...
 * Resumable: pages already present (same index) are skipped. Verifies the page
 * count matches the resolved URL list before reporting success.
 *
 * @param {object} provider  a download-capable provider
 * @param {object} chapter   row with { providerChapterId, number }
 * @param {{ concurrency?: number, dataSaver?: boolean }} opts
 * @returns {Promise<{ dir: string, pageCount: number }>}
 */
export async function downloadChapter(provider, chapter, opts = {}) {
  if (!provider.capabilities?.download) {
    throw new Error(`Provider ${provider.name} cannot download pages`);
  }
  const { concurrency = 4, dataSaver = false, onProgress, signal } = opts;
  const dir = chapterStagingDir(chapter.series_id ?? chapter.seriesId, chapter.number);

  const seriesId = chapter.series_id ?? chapter.seriesId;
  const chapterId = chapter.id;
  debugLog('downloader.chapter_start', { seriesId, chapterId, message: `Resolving pages for Chapter ${chapter.number}` });
  const targetId = (chapter.download_url && !chapter.download_url.startsWith('http')) ? chapter.download_url : (chapter.providerChapterId ?? chapter.provider_chapter_id);
  const pages = await provider.getChapterPages(targetId, {
    dataSaver,
    mangaId: opts.mangaId,
    chapterNum: chapter.number,
    lang: chapter.language ?? opts.lang ?? 'en',
  });
  const entries = normalizeEntries(pages);
  if (!entries.length) throw new Error(`No pages resolved for chapter ${chapter.number}`);
  debugLog('downloader.chapter_resolved', { seriesId, chapterId, message: `Resolved ${entries.length} pages for Chapter ${chapter.number}` });

  return fetchPagesToStaging(dir, entries, { concurrency, onProgress, signal, seriesId, chapterId });
}


export async function scoreChapterQuality(dir, totalPages) {
  if (totalPages <= 0) return { scanQuality: 'unknown', minPageWidth: null };
  const indices = [...new Set([
    0, Math.floor(totalPages / 4), Math.floor(totalPages / 2),
    Math.floor(3 * totalPages / 4), totalPages - 1
  ])];
  const widths = [];

  try {
    const files = (await readdir(dir)).filter(f => !f.endsWith('.part')).sort();
    for (const i of indices) {
      if (!files[i]) continue;
      let fd;
      try {
        fd = await open(path.join(dir, files[i]), 'r');
        const buf = Buffer.alloc(512);
        const { bytesRead } = await fd.read(buf, 0, 512, 0);
        if (bytesRead >= 24) {
          const dim = imageDimensions(buf);
          if (dim) widths.push(dim.w);
        }
      } catch (err) {
      } finally {
        if (fd) await fd.close();
      }
    }
  } catch(err) {
  }

  if (!widths.length) return { scanQuality: 'unknown', minPageWidth: null };
  const minWidth = Math.min(...widths);
  const scanQuality = minWidth < 800 ? 'low' : minWidth < 1200 ? 'ok' : 'high';
  return { scanQuality, minPageWidth: minWidth };
}
