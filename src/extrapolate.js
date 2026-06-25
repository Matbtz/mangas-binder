/**
 * Returns stats about the volume map useful for detecting outliers.
 * { lastConsecutive, avgChsPerVol, consecutiveVolSet }
 */
export function getVolumeStats(volumeMap) {
  const knownVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  const sortedVolNums = knownVols.map(([k]) => parseFloat(k)).sort((a, b) => a - b);
  let lastConsecutive = 0;
  for (const v of sortedVolNums) {
    if (v <= lastConsecutive + 1.5) lastConsecutive = v;
    else break;
  }

  const consecutiveVols = knownVols.filter(([k]) => parseFloat(k) <= lastConsecutive);
  const totalConsecChapters = consecutiveVols.reduce((sum, [, chs]) => sum + chs.length, 0);
  const avgChsPerVol = consecutiveVols.length > 0
    ? Math.round(totalConsecChapters / consecutiveVols.length)
    : 10;
  const consecutiveVolSet = new Set(consecutiveVols.map(([k]) => String(parseFloat(k))));

  return { lastConsecutive, avgChsPerVol, consecutiveVolSet };
}

/**
 * Extrapolates missing volumes from known volume/chapter data.
 *
 * Steps:
 *  1. Find the last CONSECUTIVE volume (1, 2, 3, ... N without gaps) to ignore
 *     sparse/anomalous high-numbered volumes (e.g. MangaDex has vol 23 but not 11-22).
 *  2. Calculate chsPerVol = round(avg chapters per consecutive volume).
 *  3a. If totalVolumesHint is given: iterate volNum = baseVol+1 to totalVolumesHint,
 *      skip already-confirmed volumes, assign chsPerVol chapters to each slot.
 *      Remaining chapters that don't fit → returned as `overflow`.
 *  3b. If no hint: batch all chapters in groups of chsPerVol (no overflow).
 *  4. Skip volume numbers already present in volumeMap.
 *
 * Returns { calculated, overflow }
 *   calculated: { "12": ["103","104",...], "13": [...], ... }
 *   overflow:   ["130","131",...]  — chapters beyond totalVolumesHint
 */
export function extrapolateVolumes(volumeMap, unassignedChapters, totalVolumesHint = null) {
  if (!unassignedChapters.length) return { calculated: {}, overflow: [] };

  const knownVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  if (!knownVols.length) return { calculated: {}, overflow: [] };

  const sortedVolNums = knownVols.map(([k]) => parseFloat(k)).sort((a, b) => a - b);

  // Find last consecutive volume (handles sparse gaps like vol 10 → vol 23)
  let lastConsecutive = 0;
  for (const v of sortedVolNums) {
    if (v <= lastConsecutive + 1.5) lastConsecutive = v;
    else break;
  }
  const baseVol = lastConsecutive || sortedVolNums[sortedVolNums.length - 1];

  // Average chapters/volume from consecutive volumes only
  const consecutiveVols = knownVols.filter(([k]) => parseFloat(k) <= lastConsecutive);
  const totalConsecChapters = consecutiveVols.reduce((sum, [, chs]) => sum + chs.length, 0);
  const chsPerVol = consecutiveVols.length > 0
    ? Math.round(totalConsecChapters / consecutiveVols.length)
    : 10;

  const sortedUnassigned = [...unassignedChapters].sort((a, b) => parseFloat(a) - parseFloat(b));
  // Only skip volumes from the consecutive range — sparse outliers (e.g. a single
  // bonus chapter tagged as "volume 23" on MangaDex) should not block a slot.
  const consecutiveVolSet = new Set(consecutiveVols.map(([k]) => String(parseFloat(k))));

  const calculated = {};
  let i = 0;

  if (totalVolumesHint && totalVolumesHint > baseVol) {
    // Fill volumes sequentially from baseVol+1 to totalVolumesHint
    for (let volNum = Math.floor(baseVol) + 1; volNum <= totalVolumesHint; volNum++) {
      if (consecutiveVolSet.has(String(volNum))) continue; // in solid baseline, skip
      if (i >= sortedUnassigned.length) break;             // no more chapters to assign
      calculated[String(volNum)] = sortedUnassigned.slice(i, i + chsPerVol);
      i += chsPerVol;
    }
  } else {
    // No upper bound: group all chapters in batches of chsPerVol
    let volNum = Math.floor(baseVol) + 1;
    while (i < sortedUnassigned.length) {
      while (consecutiveVolSet.has(String(volNum))) volNum++;
      calculated[String(volNum)] = sortedUnassigned.slice(i, i + chsPerVol);
      i += chsPerVol;
      volNum++;
    }
  }

  const overflow = sortedUnassigned.slice(i);
  return { calculated, overflow };
}
