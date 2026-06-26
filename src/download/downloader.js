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

/** Staging directory for a chapter's downloaded pages. */
export function chapterStagingDir(seriesId, number) {
  return path.join(getSetting('stagingDir', config.stagingDir), String(seriesId), `ch${number}`);
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
  await mkdir(dir, { recursive: true });

  const targetId = (chapter.download_url && !chapter.download_url.startsWith('http')) ? chapter.download_url : (chapter.providerChapterId ?? chapter.provider_chapter_id);
  const urls = await provider.getChapterPages(targetId, { dataSaver, mangaId: opts.mangaId, chapterNum: chapter.number });
  if (!urls.length) throw new Error(`No pages resolved for chapter ${chapter.number}`);

  const limit = pLimit(concurrency);
  const headers = { 'User-Agent': USER_AGENT };

  let done = 0;
  onProgress?.(0, urls.length);
  await Promise.all(urls.map((url, i) => limit(async () => {
    if (signal?.aborted) throw abortError();
    const dest = path.join(dir, `${pad(i + 1)}${extFromUrl(url)}`);
    if (existsSync(dest)) { onProgress?.(++done, urls.length); return; }
    const res = await fetchRetry(url, { headers, signal });
    if (!res.ok) throw new Error(`Page ${i + 1} HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error(`Page ${i + 1} empty`);
    // Atomic-ish write: temp then rename so a crash never leaves a partial page.
    const tmp = `${dest}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, dest);
    onProgress?.(++done, urls.length);
  })));

  const written = (await readdir(dir)).filter(f => !f.endsWith('.part'));
  if (written.length < urls.length) {
    throw new Error(`Downloaded ${written.length}/${urls.length} pages for chapter ${chapter.number}`);
  }
  return { dir, pageCount: urls.length };
}
