import { ZipArchive } from 'archiver';
import { createWriteStream, existsSync } from 'fs';
import { readdir, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { processPage, isNoop } from './image-preprocess.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

function padNum(n, width) {
  return String(n).padStart(width, '0');
}

function chapterKey(chapterNum) {
  const parts = String(chapterNum).split('.');
  const main = padNum(parseInt(parts[0], 10), 4);
  return parts.length > 1 ? `${main}.${parts[1]}` : main;
}

/**
 * Download a URL and return a Buffer, or null on failure.
 */
export async function downloadBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Build the list of entries (images + optional cover + optional ComicInfo.xml)
 * for a single CBZ volume.
 *
 * Entry shape:
 *   { archiveName, sourcePath }  — file on disk
 *   { archiveName, content }     — Buffer/string in memory
 */
/**
 * Tome-compatible CBZ filename for a volume.
 * Matches Tome's "Series Vol. N" / "Series, Vol. N" filename parser; ComicInfo.xml
 * still takes precedence inside the archive. Calculated/estimated volumes are tagged
 * in ComicInfo Notes, not in the filename, so they import cleanly.
 */
export function volumeCbzName(mangaName, volumeLabel) {
  if (volumeLabel === 'none') return `${mangaName} - Unsorted.cbz`;
  const volPadded = isNaN(Number(volumeLabel))
    ? volumeLabel
    : padNum(Number(volumeLabel), 2);
  return `${mangaName} Vol. ${volPadded}.cbz`;
}

/** Tome-compatible CBZ filename for a single chapter. */
export function chapterCbzName(mangaName, chapterNum) {
  return `${mangaName} - Chapter ${chapterKey(chapterNum)}.cbz`;
}

/**
 * CBZ filename for a single comic issue, e.g. "Saga #001.cbz" — the convention
 * Komga/Kavita/Tome parse for issues. Decimal issues (e.g. 1.5) are preserved.
 */
export function issueCbzName(seriesName, issueNum) {
  const n = String(issueNum);
  const padded = n.includes('.')
    ? `${padNum(parseInt(n, 10), 3)}.${n.split('.')[1]}`
    : padNum(parseInt(n, 10), 3);
  return `${seriesName} #${padded}.cbz`;
}

/**
 * Build the ordered CBZ entry list: optional cover (sorts first), all chapter
 * pages renamed to ch{NNNN}_p{NNN}.ext, then ComicInfo.xml at the root.
 * `chapters` is a list of chapter numbers; `localChapters` maps number -> folder.
 * @returns {Promise<Array<{archiveName, sourcePath?, content?}>>}
 */
export async function buildEntries(chapters, localChapters, { comicInfoXml = null, coverBuffer = null, preprocess = null, workDir = null, stats = null } = {}) {
  const entries = [];
  // Only run the image pipeline when a profile with at least one active block is
  // supplied and we have a scratch dir to stream processed pages from.
  const doProcess = preprocess && workDir && !isNoop(preprocess);
  if (doProcess) await mkdir(workDir, { recursive: true });

  // Cover image — sorts before all chapter pages alphabetically. Left untouched
  // (provider art, not a scanned page).
  if (coverBuffer) {
    entries.push({ archiveName: '000_cover.jpg', content: coverBuffer });
  }

  // Chapter pages
  const sortedChapters = [...chapters].sort((a, b) => parseFloat(a) - parseFloat(b));
  for (const chNum of sortedChapters) {
    const folderPath = localChapters[Object.keys(localChapters).find(k => parseFloat(k) === parseFloat(chNum))];
    // Skip a chapter whose pages aren't on disk rather than throwing — a missing
    // staging dir must never abort the whole volume bind.
    if (!folderPath || !existsSync(folderPath)) continue;

    let files;
    try {
      files = (await readdir(folderPath))
        .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
        .sort();
    } catch { continue; }
    if (!files.length) continue;

    const chKey = chapterKey(chNum);
    // Page counter is incremented per *output* image so a split spread yields two
    // correctly numbered, contiguous pages.
    let page = 0;
    for (const file of files) {
      const sourcePath = path.join(folderPath, file);
      if (doProcess) {
        let outputs;
        try {
          outputs = await processPage(sourcePath, preprocess);
          if (stats) stats.processed++;
        } catch {
          // A page that can't be processed is packed as-is rather than lost.
          outputs = null;
          if (stats) stats.failed++;
        }
        if (outputs) {
          for (const { buffer, ext } of outputs) {
            page += 1;
            const tmpName = `ch${chKey}_p${padNum(page, 3)}${ext}`;
            const tmpPath = path.join(workDir, tmpName);
            await writeFile(tmpPath, buffer);
            entries.push({ archiveName: tmpName, sourcePath: tmpPath });
          }
          continue;
        }
      }
      page += 1;
      const ext = path.extname(file);
      entries.push({ archiveName: `ch${chKey}_p${padNum(page, 3)}${ext}`, sourcePath });
    }
  }

  // ComicInfo.xml — must be at root of the ZIP
  if (comicInfoXml) {
    entries.push({ archiveName: 'ComicInfo.xml', content: Buffer.from(comicInfoXml, 'utf-8') });
  }

  return entries;
}

export async function buildJob(volumeLabel, chapters, localChapters, outputDir, mangaName, isCalculated = false, comicInfoXml = null, coverBuffer = null, { preprocess = null, workDir = null } = {}) {
  const outputPath = path.join(outputDir, volumeCbzName(mangaName, volumeLabel));
  const entries = await buildEntries(chapters, localChapters, { comicInfoXml, coverBuffer, preprocess, workDir });
  return { outputPath, entries };
}

export async function createCbz(job, onProgress) {
  await mkdir(path.dirname(job.outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = createWriteStream(job.outputPath);
    // zlib level 0 = store only — images are already compressed
    const archive = new ZipArchive({ zlib: { level: 0 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    let current = 0;
    archive.on('entry', () => {
      current++;
      if (onProgress) onProgress({ current, total: job.entries.length });
    });

    for (const entry of job.entries) {
      if (entry.content !== undefined) {
        archive.append(entry.content, { name: entry.archiveName });
      } else {
        archive.file(entry.sourcePath, { name: entry.archiveName });
      }
    }

    archive.finalize();
  });
}
