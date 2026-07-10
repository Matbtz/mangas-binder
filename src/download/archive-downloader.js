import { writeFile, mkdir, rm, rename } from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import { fetchRetry } from './limit.js';
import { chapterStagingDir } from './downloader.js';
import { solve as flareSolve, cookieHeader, isEnabled as flareEnabled } from './flaresolverr.js';
import { logHistory } from '../core/db.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) mangas-binder/2.0';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
// Page naming the binder writes into volume CBZs, e.g. ch0012_p003.jpg — lets us
// pull a single chapter back out of a multi-chapter volume archive.
const CBZ_PAGE_RE = /^ch(\d+(?:\.\d+)?)_p\d+/i;

function pad(n, w = 3) { return String(n).padStart(w, '0'); }

/**
 * Download a whole comic archive (CBZ/ZIP) for one issue and extract its page
 * images into the chapter staging dir as 001.ext, 002.ext … — exactly the layout
 * the page downloader produces — so the shared binder/packager pipeline handles
 * comics and manga identically from here on.
 *
 * Only zip-family archives (CBZ/ZIP) are supported; CBR (RAR) needs an external
 * unrar and is rejected with a clear message rather than failing obscurely.
 *
 * @param {object} provider  an archive-capable provider (capabilities.archive)
 * @param {object} series    series row (title, year)
 * @param {object} chapter   chapter row (number)
 * @returns {Promise<{ dir: string, pageCount: number }>}
 */
export async function downloadArchiveChapter(provider, series, chapter, { signal } = {}) {
  if (!provider.capabilities?.archive) {
    throw new Error(`Provider ${provider.name} cannot resolve archives`);
  }
  const customUrl = chapter.download_url || chapter.downloadUrl;
  const found = customUrl
    ? (provider.resolvePostUrl ? await provider.resolvePostUrl(customUrl) : { url: customUrl, kind: customUrl.endsWith('.zip') ? 'zip' : 'cbz' })
    : await provider.findIssueDownload(series, chapter);

  // Providers now hand back every ranked mirror as `urls`; older shapes / the
  // no-resolvePostUrl branch still carry a single `url`.
  const candidates = found?.urls?.length ? found.urls : (found?.url ? [found.url] : []);
  if (!candidates.length) throw new Error(`No download found for ${series.title} #${chapter.number}`);
  if (found.kind === 'cbr') {
    throw new Error(`Got a CBR (RAR) archive for #${chapter.number}; CBR isn't supported — only CBZ/ZIP.`);
  }

  const headers = { 'User-Agent': USER_AGENT, ...(found.headers || {}) };
  // Try each mirror in turn; the first that yields a valid archive wins. GetComics'
  // top-ranked "main server" mirror redirects to Cloudflare-gated comicfiles.ru
  // hosts that FlareSolverr often can't solve, so falling back to the pixeldrain
  // mirror (a clean, un-gated direct API) is what actually gets the file.
  let lastErr;
  for (const candidate of candidates) {
    try {
      const buf = await fetchArchiveBuffer(candidate, headers, signal);
      return await extractToStaging(buf, series.id, chapter.number);
    } catch (err) {
      lastErr = err;
      if (candidates.length > 1) {
        logHistory('archive.mirror.failed', { message: `Mirror failed for #${chapter.number}: ${err.message}` });
      }
    }
  }
  throw new Error(`Archive download failed for #${chapter.number}: ${lastErr?.message || 'no working mirror'}`);
}

/**
 * Fetch one mirror candidate and return the raw archive bytes, or throw if this
 * mirror doesn't yield a valid CBZ/ZIP (so the caller can try the next one).
 */
async function fetchArchiveBuffer(url, headers, signal) {
  let res = await fetchRetry(url, { headers, retries: 3, signal });
  // fetch()'s `url` reflects the final address after following redirects — GetComics'
  // short-lived /dls/ links 302 out to the real mirror host.
  let finalUrl = res.url || url;

  // Some mirrors hand back an intermediate page, not the file — resolve those to a
  // real direct-download URL before we validate/keep the response.
  const pd = finalUrl.match(/^https?:\/\/pixeldrain\.com\/u\/([\w-]+)/i);
  if (pd) {
    // Pixeldrain: /u/{id} is an HTML viewer; its direct API /api/file/{id} serves
    // the raw CBZ and isn't Cloudflare-gated (pure URL rewrite, no page parse).
    finalUrl = `https://pixeldrain.com/api/file/${pd[1]}`;
    res = await fetchRetry(finalUrl, { headers, retries: 3, signal });
  } else if (/mediafire\.com\/(?:file|file_premium)\//i.test(finalUrl)) {
    // MediaFire: the /file/ landing page holds the real download*.mediafire.com
    // link in its download button — parse it out and fetch that directly.
    const direct = extractMediafireDirect(await res.text());
    if (direct) {
      finalUrl = direct;
      res = await fetchRetry(finalUrl, { headers, retries: 3, signal });
    }
  } else if (/wetransfer\.com\/downloads\//i.test(finalUrl)) {
    // WeTransfer: the download page is a JS SPA; the real file link comes from a
    // POST to its download API (transfer id from the URL + security hash from the
    // page), which returns a direct storage link. Best-effort — most GetComics
    // WeTransfer links are expired or DMCA-blocked, so this usually returns null
    // and we fall through to the next mirror.
    const cookies = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    const direct = await resolveWetransferDirect(finalUrl, await res.text(), cookies, signal);
    if (direct) {
      finalUrl = direct;
      res = await fetchRetry(finalUrl, { headers, retries: 3, signal });
    }
  }

  // Cloudflare-challenged mirror (comicfiles.ru et al.): a Referer/User-Agent alone
  // can't pass a real JS challenge — only a browser that solves it can. If
  // FlareSolverr is configured, solve the mirror's ORIGIN ROOT (never the file URL:
  // once the challenge passes Cloudflare returns the raw archive, which makes
  // FlareSolverr's headless Chrome attempt a native download and crash the
  // navigation → a bare HTTP 500). The resulting cf_clearance cookie is valid for
  // the whole zone; retry the file URL DIRECTLY with it — a manually-set Cookie
  // header does not survive fetch()'s cross-origin redirect, so we must not retry
  // the original redirecting /dls/ link.
  if (res.status === 403 && flareEnabled()) {
    try {
      const origin = `${new URL(finalUrl).origin}/`;
      const { cookies, userAgent } = await flareSolve(origin, { signal });
      const cookieStr = cookieHeader(cookies);
      if (cookieStr) {
        const solvedHeaders = { ...headers, 'User-Agent': userAgent || headers['User-Agent'], Cookie: cookieStr };
        res = await fetchRetry(finalUrl, { headers: solvedHeaders, retries: 1, signal });
      }
    } catch (solveErr) {
      logHistory('flaresolverr.error', { message: `FlareSolverr failed to solve ${finalUrl}: ${solveErr.message}` });
    }
  }

  if (!res.ok) {
    throw new Error(`Archive HTTP ${res.status}${res.status === 403 ? ' (Cloudflare — configure FlareSolverr in Settings → Sources)' : ''}`);
  }

  // A challenge / error page comes back as HTML, not the archive — reject it so the
  // caller falls through to the next mirror instead of choking on a bad zip.
  const contentType = res.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) {
    throw new Error(`Mirror returned an HTML page, not an archive (${finalUrl})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('Empty archive');
  // Validate the zip local-file-header magic (PK\x03\x04 / \x05\x06 / \x07\x08) so a
  // stray HTML/JSON body served with a non-HTML content-type is caught here too.
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('Downloaded file is not a zip/CBZ archive');
  }
  return buf;
}

/**
 * Pull MediaFire's real download*.mediafire.com URL out of a /file/ landing page.
 * The download button's href carries it directly; newer pages occasionally
 * base64-scramble it into a `data-scrambled-url` attribute instead.
 * @returns {string|null}
 */
export function extractMediafireDirect(html) {
  const direct = html.match(/href="(https?:\/\/download[^"]+\.mediafire\.com\/[^"]+)"/i);
  if (direct) return direct[1].replace(/&amp;/g, '&');
  const scrambled = html.match(/data-scrambled-url="([^"]+)"/i);
  if (scrambled) {
    try {
      const decoded = Buffer.from(scrambled[1], 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch { /* not valid base64 — fall through */ }
  }
  return null;
}

/**
 * Pull the transfer id + security hash (and CSRF token, if present) out of a
 * WeTransfer download page. The transfer id is the first path segment after
 * /downloads/; the security hash is the last path segment, but the copy embedded
 * in the page (`securityHash`) wins when present.
 * @returns {{ transferId: string, securityHash: string, csrf: string|null }|null}
 */
export function extractWetransferParams(pageUrl, html) {
  const m = pageUrl.match(/wetransfer\.com\/downloads\/([0-9a-z]+)(?:\/([0-9a-z]+))?\/([0-9a-z]+)/i);
  if (!m) return null;
  const transferId = m[1];
  let securityHash = m[3];
  const embedded = html.match(/"securityHash"\s*:\s*"([^"]+)"/);
  if (embedded) securityHash = embedded[1];
  if (!transferId || !securityHash) return null;
  const csrf = (html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)
    || html.match(/"csrfToken"\s*:\s*"([^"]+)"/) || [])[1] || null;
  return { transferId, securityHash, csrf };
}

/**
 * Resolve a WeTransfer download page to its direct storage link by calling the
 * transfer download API. Returns null on any failure (expired/blocked transfer,
 * API shape change, missing params) so the caller falls through to the next
 * mirror. Best-effort: the happy path can't be verified offline because live,
 * non-blocked GetComics WeTransfer links are essentially unavailable.
 * @returns {Promise<string|null>}
 */
export async function resolveWetransferDirect(pageUrl, html, cookies, signal) {
  const params = extractWetransferParams(pageUrl, html);
  if (!params) return null;
  const api = `https://wetransfer.com/api/v4/transfers/${params.transferId}/download`;
  const reqHeaders = {
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    Referer: pageUrl,
    ...(params.csrf ? { 'x-csrf-token': params.csrf } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
  };
  try {
    const r = await fetch(api, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({ security_hash: params.securityHash, intent: 'entire_transfer' }),
      signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data?.direct_link === 'string' ? data.direct_link : null;
  } catch {
    return null;
  }
}

/**
 * Restore several chapters out of ONE packaged (multi-chapter) volume CBZ in a
 * single parse of the archive, writing each chapter's pages to its own staging
 * dir. This replaces calling extractToStaging({ onlyChapter }) once per chapter,
 * which re-parsed the whole archive N times when re-packaging a volume.
 *
 * Only works for our own packaged archives (pages named `ch{NNNN}_p{NNN}`); for
 * a foreign archive with no such naming it returns an empty set so the caller
 * can fall back to the per-chapter path.
 *
 * @returns {Promise<Set<string>>} the chapter numbers (normalised) it extracted
 */
export async function extractChaptersFromArchive(zipBuffer, seriesId, chapterNumbers) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error('Downloaded file is not a readable zip/CBZ archive');
  }
  const images = zip.getEntries()
    .filter(e => !e.isDirectory && IMAGE_EXTS.has(path.extname(e.entryName).toLowerCase()));
  const isPackaged = images.some(e => CBZ_PAGE_RE.test(path.basename(e.entryName)));
  if (!isPackaged) return new Set(); // caller falls back to per-chapter extraction

  // Bucket every page by the chapter number encoded in its name.
  const wanted = new Set([...chapterNumbers].map(n => String(parseFloat(n))));
  const byChapter = new Map(); // normalised number -> entries[]
  for (const e of images) {
    const m = path.basename(e.entryName).match(CBZ_PAGE_RE);
    if (!m) continue;
    const key = String(parseFloat(m[1]));
    if (!wanted.has(key)) continue;
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(e);
  }

  const extracted = new Set();
  for (const [key, entries] of byChapter) {
    entries.sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    const dir = chapterStagingDir(seriesId, key);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    let i = 0;
    for (const entry of entries) {
      const ext = path.extname(entry.entryName).toLowerCase();
      const dest = path.join(dir, `${pad(++i)}${ext}`);
      const tmp = `${dest}.part`;
      await writeFile(tmp, entry.getData());
      await rename(tmp, dest);
    }
    if (i > 0) extracted.add(key);
  }
  return extracted;
}

/**
 * Extract image entries from an in-memory zip buffer into the chapter staging
 * dir, renumbered in archive order. Exposed for offline testing.
 * @returns {Promise<{ dir, pageCount }>}
 */
export async function extractToStaging(zipBuffer, seriesId, number, { onlyChapter = null } = {}) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error('Downloaded file is not a readable zip/CBZ archive');
  }
  let images = zip.getEntries()
    .filter(e => !e.isDirectory && IMAGE_EXTS.has(path.extname(e.entryName).toLowerCase()))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

  // When restoring a single chapter out of one of our own packaged (possibly
  // multi-chapter) volume CBZs, keep only that chapter's pages. Foreign archives
  // that don't use the ch{NNNN}_p naming are extracted whole (single-issue case).
  if (onlyChapter != null) {
    const want = String(parseFloat(onlyChapter));
    const isPackaged = images.some(e => CBZ_PAGE_RE.test(path.basename(e.entryName)));
    if (isPackaged) {
      images = images.filter(e => {
        const m = path.basename(e.entryName).match(CBZ_PAGE_RE);
        return m && String(parseFloat(m[1])) === want;
      });
    }
  }
  if (!images.length) throw new Error('Archive contains no page images');

  const dir = chapterStagingDir(seriesId, number);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let i = 0;
  for (const entry of images) {
    const ext = path.extname(entry.entryName).toLowerCase();
    const dest = path.join(dir, `${pad(++i)}${ext}`);
    const tmp = `${dest}.part`;
    await writeFile(tmp, entry.getData());
    await rename(tmp, dest);
  }
  return { dir, pageCount: images.length };
}

/**
 * Write manually-uploaded loose page images into the chapter staging dir,
 * renumbered by original filename order (numeric-aware sort) — the same
 * 001.ext, 002.ext … layout extractToStaging/downloadChapter produce, so a
 * manual upload feeds the shared binder/packager pipeline identically to a
 * real download. Non-image files are silently dropped, same as extractToStaging.
 * @param {Array<{ filename: string, buf: Buffer }>} files
 * @returns {Promise<{ dir, pageCount }>}
 */
export async function extractUploadedImagesToStaging(files, seriesId, number) {
  const images = files
    .filter(f => IMAGE_EXTS.has(path.extname(f.filename || '').toLowerCase()))
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  if (!images.length) throw new Error('No page images found in upload');

  const dir = chapterStagingDir(seriesId, number);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let i = 0;
  for (const img of images) {
    const ext = path.extname(img.filename).toLowerCase();
    const dest = path.join(dir, `${pad(++i)}${ext}`);
    const tmp = `${dest}.part`;
    await writeFile(tmp, img.buf);
    await rename(tmp, dest);
  }
  return { dir, pageCount: images.length };
}
