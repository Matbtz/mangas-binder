import { writeFile, mkdir, rm, rename } from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import { fetchRetry } from './limit.js';
import { chapterStagingDir } from './downloader.js';

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

  const res = await fetchRetry(found.url, { headers: { 'User-Agent': USER_AGENT }, retries: 3, signal });
  if (!res.ok) throw new Error(`Archive HTTP ${res.status} for #${chapter.number}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Empty archive for #${chapter.number}`);

  return extractToStaging(buf, series.id, chapter.number);
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
