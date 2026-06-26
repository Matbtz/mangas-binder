import { readdir } from 'fs/promises';
import path from 'path';

const CHAPTER_REGEX = /(?:ch(?:apter)?\.?\s*|ch_)(\d+(?:\.\d+)?)/i;
const BARE_NUMBER_REGEX = /^(\d+(?:\.\d+)?)$/;

export function extractChapterNumber(folderName) {
  const m = folderName.match(CHAPTER_REGEX);
  if (m) return m[1];
  const b = folderName.match(BARE_NUMBER_REGEX);
  if (b) return b[1];
  return null;
}

/** Returns { "103": "/abs/path/Chapter 103", ... } */
export async function scanLocalChapters(inputDir) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const num = extractChapterNumber(entry.name);
    if (num !== null) {
      result[num] = path.join(inputDir, entry.name);
    }
  }
  return result;
}

/**
 * Returns:
 *   matched:   [{ volume, chapterNum, folderPath }]
 *   unmatched: [chapterNum]  — local chapters not in any volume
 *   missing:   [chapterNum]  — API chapters with no local folder
 */
export function matchChapterToVolume(localChapters, volumeMap) {
  const matched = [];
  const missing = [];

  const allApiChapters = new Set();

  for (const [volume, chapters] of Object.entries(volumeMap)) {
    for (const chNum of chapters) {
      allApiChapters.add(chNum);
      const localKey = findLocalKey(localChapters, chNum);
      if (localKey !== null) {
        matched.push({ volume, chapterNum: chNum, folderPath: localChapters[localKey] });
      } else {
        missing.push(chNum);
      }
    }
  }

  const unmatched = Object.keys(localChapters).filter(
    k => ![...allApiChapters].some(api => parseFloat(api) === parseFloat(k))
  );

  return { matched, unmatched, missing };
}

function findLocalKey(localChapters, apiChapterNum) {
  const apiNum = parseFloat(apiChapterNum);
  for (const key of Object.keys(localChapters)) {
    if (parseFloat(key) === apiNum) return key;
  }
  return null;
}
