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
 * Extrapolates missing volumes from known volume/chapter anchor points.
 *
 * For any unassigned chapter:
 *  1. Finds the nearest preceding anchor volume (maxCh < chNum).
 *  2. Finds the nearest succeeding anchor volume (minCh > chNum).
 *  3. Calculates estimated volume = baseVol + ceil((chNum - anchorCh) / chsPerVol).
 *  4. Clamps estimated volume so it never overshoots the succeeding anchor volume.
 *
 * Returns { calculated, overflow }
 */
export function extrapolateVolumes(volumeMap, unassignedChapters, totalVolumesHint = null, capAtHint = true, chsPerVolOverride = null) {
  if (!unassignedChapters.length) return { calculated: {}, overflow: [] };

  const knownVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  let chsPerVol = chsPerVolOverride || 10;
  const knownSet = new Set();
  const anchors = []; // [{ volNum, minCh, maxCh }]

  if (knownVols.length > 0) {
    let totalChapters = 0;
    for (const [vStr, chs] of knownVols) {
      const vNum = parseFloat(vStr);
      if (Number.isNaN(vNum)) continue;
      knownSet.add(String(vNum));
      totalChapters += chs.length;
      let minCh = Infinity, maxCh = -Infinity;
      for (const c of chs) {
        if (String(c).includes('.')) continue; // ignore fractional chapters for volume anchor boundaries
        const cNum = parseFloat(c);
        if (!Number.isNaN(cNum) && Number.isInteger(cNum)) {
          if (cNum < minCh) minCh = cNum;
          if (cNum > maxCh) maxCh = cNum;
        }
      }
      if (maxCh > -Infinity) anchors.push({ volNum: vNum, minCh, maxCh });
    }
    if (!chsPerVolOverride) {
      const stats = getVolumeStats(volumeMap);
      chsPerVol = stats.avgChsPerVol || 10;
      if (chsPerVol < 3) chsPerVol = 10; // safety clamp to prevent sparse/erroneous metadata from causing 1-chapter volumes
    }
    anchors.sort((a, b) => a.maxCh - b.maxCh);
  }

  const sortedUnassigned = [...unassignedChapters].sort((a, b) => parseFloat(a) - parseFloat(b));
  const calculated = {};
  const overflow = [];

  for (const chStr of sortedUnassigned) {
    const chNum = parseFloat(chStr);
    if (Number.isNaN(chNum)) { overflow.push(chStr); continue; }

    if (String(chStr).includes('.') || !Number.isInteger(chNum)) {
      (calculated['Specials'] ||= []).push(chStr);
      continue;
    }

    let baseVol = 0, anchorCh = 0;
    let nextVol = Infinity;

    for (let j = 0; j < anchors.length; j++) {
      if (anchors[j].maxCh < chNum) {
        baseVol = anchors[j].volNum;
        anchorCh = anchors[j].maxCh;
      }
      if (anchors[j].minCh > chNum && anchors[j].volNum < nextVol) {
        nextVol = anchors[j].volNum;
      }
    }

    const diff = Math.max(1, chNum - anchorCh);
    let estVol = Math.floor(baseVol) + Math.max(1, Math.ceil(diff / chsPerVol));
    if (nextVol < Infinity) {
      estVol = Math.min(estVol, Math.floor(nextVol) - 1);
    }

    if (capAtHint && totalVolumesHint && estVol > totalVolumesHint) {
      overflow.push(chStr);
    } else {
      (calculated[String(estVol)] ||= []).push(chStr);
    }
  }

  return { calculated, overflow };
}
