import { open } from 'fs/promises';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal, allocation-frugal ZIP reader for library reconciliation.
 *
 * A CBZ volume can be hundreds of MB, yet reconciliation only needs two tiny
 * things: the list of entry *names* (page filenames encode chapter membership,
 * e.g. `ch0012_p003.jpg`) and the small `ComicInfo.xml`. Loading the whole
 * archive into memory just to read those — which is what `adm-zip` does in its
 * constructor — is pure waste and is catastrophic over a network mount (the
 * library lives on a NAS): it turns a few-KB read into a few-hundred-MB transfer
 * per file and pins that memory, which is the root cause of the scan freezes.
 *
 * This reads only the End-Of-Central-Directory + central directory (file tail)
 * to enumerate names, and inflates a single requested entry on demand. It throws
 * on anything it can't handle confidently (zip64, unknown compression, truncation)
 * so callers can fall back to a full reader for those rare archives.
 */

const EOCD_SIG = 0x06054b50; // End of central directory
const CDFH_SIG = 0x02014b50; // Central directory file header
const LFH_SIG = 0x04034b50;  // Local file header
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/**
 * Read a zip's central directory without loading the archive body.
 * @param {string} filePath
 * @param {{ wantEntry?: (name: string) => boolean }} opts
 *   `wantEntry` selects (at most) one entry to also inflate and return.
 * @returns {Promise<{ names: string[], entryData: Buffer|null }>}
 */
export async function readZipDirectory(filePath, { wantEntry } = {}) {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < EOCD_MIN) throw new Error('file too small to be a zip');

    // Locate the EOCD record by scanning the file tail backwards.
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const tail = Buffer.allocUnsafe(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('EOCD signature not found');

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    // 0xffff / 0xffffffff sentinels mean zip64 — defer to the full reader.
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('zip64 archive');
    }
    if (cdOffset + cdSize > size) throw new Error('central directory out of range');

    const cd = Buffer.allocUnsafe(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const names = [];
    let target = null;
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CDFH_SIG) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      names.push(name);
      if (!target && wantEntry && wantEntry(name)) target = { method, compSize, localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }

    const entryData = target ? await readLocalEntry(fh, target) : null;
    return { names, entryData };
  } finally {
    await fh.close();
  }
}

/** Read + decompress a single entry given its central-directory record. */
async function readLocalEntry(fh, { method, compSize, localOff }) {
  const lfh = Buffer.allocUnsafe(30);
  await fh.read(lfh, 0, 30, localOff);
  if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error('bad local file header');
  // The local header carries its own (possibly different) name/extra lengths.
  const nameLen = lfh.readUInt16LE(26);
  const extraLen = lfh.readUInt16LE(28);
  const dataOff = localOff + 30 + nameLen + extraLen;

  const comp = compSize > 0 ? Buffer.allocUnsafe(compSize) : Buffer.alloc(0);
  if (compSize > 0) await fh.read(comp, 0, compSize, dataOff);
  if (method === 0) return comp;                 // stored
  if (method === 8) return inflateRawSync(comp); // deflate
  throw new Error(`unsupported compression method ${method}`);
}
