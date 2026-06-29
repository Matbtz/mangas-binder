import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/download/downloader.js', 'utf8');

const importAdd = `import { open } from 'fs/promises';`;
content = content.replace(/import \{ existsSync \} from 'fs';/, importAdd + "\nimport { existsSync } from 'fs';");

const imageDimensionsCode = `
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
`;

content = content.replace(/\/\*\* Staging directory for a chapter's downloaded pages\. \*\//, imageDimensionsCode + "\n/** Staging directory for a chapter's downloaded pages. */");

const scoreChapterCode = `
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
`;

content = content + "\n" + scoreChapterCode;

// In fetchPagesToStaging, return { dir, pageCount, scanQuality, minPageWidth }
content = content.replace(/return \{ dir, pageCount: entries\.length \};/g, `const { scanQuality, minPageWidth } = await scoreChapterQuality(dir, entries.length);\n  return { dir, pageCount: entries.length, scanQuality, minPageWidth };`);

writeFileSync('src/download/downloader.js', content);
