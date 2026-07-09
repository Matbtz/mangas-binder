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
  if (!found?.url) throw new Error(`No download found for ${series.title} #${chapter.number}`);
  if (found.kind === 'cbr') {
    throw new Error(`Got a CBR (RAR) archive for #${chapter.number}; CBR isn't supported — only CBZ/ZIP.`);
  }

  const headers = { 'User-Agent': USER_AGENT, ...(found.headers || {}) };
  let res = await fetchRetry(found.url, { headers, retries: 3, signal });
  // fetch()'s `url` reflects the final address after following redirects — this is
  // the actual DDL mirror host (GetComics' short-lived /dls/ links 302 elsewhere),
  // which is what we need to target below, both for solving and for the retry.
  const finalUrl = res.url || found.url;

  // Many DDL mirrors (GetComics' rotating comicfiles.ru/fs*.* hosts, etc.) sit
  // behind a real Cloudflare JS challenge — a Referer/User-Agent alone can't get
  // past it, only a browser that actually solves it can. Same anti-bot situation
  // as MangaKatana: if FlareSolverr is configured, solve it to obtain the
  // cf_clearance cookie + the browser UA it used, then retry the download.
  //
  // Two things that look reasonable but don't work, discovered the hard way:
  //   - Solving the *file* URL itself: once the challenge passes, Cloudflare hands
  //     back the raw archive, which makes FlareSolverr's headless Chrome attempt a
  //     native file download instead of a page load — that crashes the navigation
  //     and FlareSolverr's own request handler, reported back to us as a bare
  //     HTTP 500 with no useful detail. Solving the mirror's origin root instead
  //     always resolves to an HTML response, so the challenge-solve stays a normal
  //     page load; the resulting cf_clearance cookie is valid for the whole zone.
  //   - Retrying against the original found.url: it 302-redirects cross-origin to
  //     the mirror, and a manually-set Cookie header does not survive a
  //     cross-origin redirect in fetch() (unlike Referer) — it gets silently
  //     dropped on the second hop, so the solved session never actually reaches
  //     the mirror. Retrying against finalUrl (the mirror URL itself) sends it
  //     directly, with no redirect to lose it across.
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
    throw new Error(`Archive HTTP ${res.status} for #${chapter.number}${res.status === 403 ? ' (Cloudflare — configure FlareSolverr in Settings → Sources)' : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Empty archive for #${chapter.number}`);

  return extractToStaging(buf, series.id, chapter.number);
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
