import { writeFile, mkdir, readdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { pLimit, fetchRetry, abortError } from './limit.js';
import { config } from '../core/config.js';
import { getSetting } from '../core/settings.js';

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
export async function fetchPagesToStaging(dir, entries, { concurrency = 4, onProgress, signal } = {}) {
  if (!entries.length) throw new Error('No pages to fetch');
  await mkdir(dir, { recursive: true });
  const limit = pLimit(concurrency);

  let done = 0;
  onProgress?.(0, entries.length);
  await Promise.all(entries.map((entry, i) => limit(async () => {
    if (signal?.aborted) throw abortError();
    const dest = path.join(dir, `${pad(i + 1)}${extFromUrl(entry.url)}`);
    if (existsSync(dest)) { onProgress?.(++done, entries.length); return; }
    const headers = { 'User-Agent': USER_AGENT, ...(entry.headers || {}) };
    const res = await fetchRetry(entry.url, { headers, signal });
    if (!res.ok) throw new Error(`Page ${i + 1} HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error(`Page ${i + 1} empty`);
    if (!isImageBuffer(buf)) throw new Error(`Page ${i + 1} is not a valid image (got ${buf.length} bytes, likely an error/challenge page)`);
    // Atomic-ish write: temp then rename so a crash never leaves a partial page.
    const tmp = `${dest}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, dest);
    onProgress?.(++done, entries.length);
  })));

  const written = (await readdir(dir)).filter(f => !f.endsWith('.part'));
  if (written.length < entries.length) {
    throw new Error(`Downloaded ${written.length}/${entries.length} pages`);
  }
  return { dir, pageCount: entries.length };
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

  const targetId = (chapter.download_url && !chapter.download_url.startsWith('http')) ? chapter.download_url : (chapter.providerChapterId ?? chapter.provider_chapter_id);
  const pages = await provider.getChapterPages(targetId, {
    dataSaver,
    mangaId: opts.mangaId,
    chapterNum: chapter.number,
    lang: chapter.language ?? opts.lang ?? 'en',
  });
  const entries = normalizeEntries(pages);
  if (!entries.length) throw new Error(`No pages resolved for chapter ${chapter.number}`);

  return fetchPagesToStaging(dir, entries, { concurrency, onProgress, signal });
}
