import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { readdir, mkdir } from 'fs/promises';
import path from 'path';

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
    const res = await fetch(url);
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
 * Build the ordered CBZ entry list: optional cover (sorts first), all chapter
 * pages renamed to ch{NNNN}_p{NNN}.ext, then ComicInfo.xml at the root.
 * `chapters` is a list of chapter numbers; `localChapters` maps number -> folder.
 * @returns {Promise<Array<{archiveName, sourcePath?, content?}>>}
 */
export async function buildEntries(chapters, localChapters, { comicInfoXml = null, coverBuffer = null } = {}) {
  const entries = [];

  // Cover image — sorts before all chapter pages alphabetically
  if (coverBuffer) {
    entries.push({ archiveName: '000_cover.jpg', content: coverBuffer });
  }

  // Chapter pages
  const sortedChapters = [...chapters].sort((a, b) => parseFloat(a) - parseFloat(b));
  for (const chNum of sortedChapters) {
    const folderPath = localChapters[Object.keys(localChapters).find(k => parseFloat(k) === parseFloat(chNum))];
    if (!folderPath) continue;

    const files = (await readdir(folderPath))
      .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    files.forEach((file, idx) => {
      const ext = path.extname(file);
      const archiveName = `ch${chapterKey(chNum)}_p${padNum(idx + 1, 3)}${ext}`;
      entries.push({ archiveName, sourcePath: path.join(folderPath, file) });
    });
  }

  // ComicInfo.xml — must be at root of the ZIP
  if (comicInfoXml) {
    entries.push({ archiveName: 'ComicInfo.xml', content: Buffer.from(comicInfoXml, 'utf-8') });
  }

  return entries;
}

export async function buildJob(volumeLabel, chapters, localChapters, outputDir, mangaName, isCalculated = false, comicInfoXml = null, coverBuffer = null) {
  const outputPath = path.join(outputDir, volumeCbzName(mangaName, volumeLabel));
  const entries = await buildEntries(chapters, localChapters, { comicInfoXml, coverBuffer });
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
