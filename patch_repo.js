import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/core/repo.js', 'utf8');

const setChapterQualityAdd = `
export function setChapterQuality(id, scanQuality, minPageWidth) {
  getDb().prepare(
    "UPDATE chapters SET scan_quality = ?, min_page_width = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(scanQuality, minPageWidth, id);
}

/** Light progress write during a download — does not touch state. */
`;

content = content.replace(/\/\*\* Light progress write during a download — does not touch state\. \*\//, setChapterQualityAdd.trim() + '\n');

writeFileSync('src/core/repo.js', content);
