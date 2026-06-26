import { mkdir, rename, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createCbz } from './packager.js';

/**
 * The Tome target: turns built CBZ entry lists into files inside OUTPUT_DIR,
 * which is the volume Tome mounts as its Bindery (or library). Files are grouped
 * one folder per series so Tome's recursive scan groups them as a series.
 */

/** Strip characters that are illegal/awkward in file names across platforms. */
export function sanitize(name) {
  return String(name)
    .replace(/[\/\\:*?"<>|]/g, ' ')   // illegal on Windows/macOS
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');             // no trailing dot/space
}

/** Absolute path of a series' folder in the output (Tome) library. */
export function seriesDir(seriesTitle) {
  return path.join(config.outputDir, sanitize(seriesTitle));
}

/** Full destination path for a CBZ given a series and a bare filename. */
export function destPath(seriesTitle, fileName) {
  return path.join(seriesDir(seriesTitle), sanitize(fileName.replace(/\.cbz$/i, '')) + '.cbz');
}

export function cbzExists(p) {
  return existsSync(p);
}

/**
 * Write an entry list to a CBZ at `dest`, atomically (temp file in the same
 * dir, then rename). Skips if it already exists unless overwrite is set.
 * @returns {Promise<{ path: string, size: number, skipped: boolean }>}
 */
export async function writeCbz(entries, dest, { overwrite = false } = {}) {
  await mkdir(path.dirname(dest), { recursive: true });
  if (!overwrite && existsSync(dest)) {
    const { size } = await stat(dest);
    return { path: dest, size, skipped: true };
  }
  const tmp = `${dest}.tmp`;
  if (existsSync(tmp)) await rm(tmp, { force: true });
  await createCbz({ outputPath: tmp, entries });
  await rename(tmp, dest);
  const { size } = await stat(dest);
  return { path: dest, size, skipped: false };
}
