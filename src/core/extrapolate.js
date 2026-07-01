/**
 * Splits noisy per-volume chapter lists into a clean, monotonic volumeMap.
 *
 * MangaDex volume tags are crowd-sourced per scanlation group, so a single
 * mistagged chapter (e.g. chapter 54 mislabeled "Volume 2") can blow out
 * that volume's min/max range far past where the *next* volume's chapters
 * start, corrupting every anchor derived from it. This:
 *  1. For each volume, keeps only chapters within a robust (median +
 *     MAD-based) band of that volume's main cluster — outliers go to `noisy`.
 *  2. Sweeps volumes in ascending order and drops any remaining chapter
 *     whose number falls at or before the previous volume's cleaned max, or
 *     at/after the next volume's cleaned min — guaranteeing non-overlapping,
 *     monotonically increasing bands.
 *  3. Demotes whole volumes whose *total size* is a severe outlier vs. the
 *     typical volume across the series (e.g. a scanlation/digital-omnibus
 *     group tagging 30+ chapters under one volume number, internally
 *     consistently — so passes 1 and 2 never see a per-chapter or overlap
 *     anomaly to reject). Observed in production on One Piece: volumes with
 *     10-12 chapters everywhere except a handful tagged with 32-33 each.
 *
 * Returns { cleanVolumeMap, noisy } where `noisy` is the flat list of
 * chapter numbers (strings) that were pulled out of their volume.
 */
export function sanitizeVolumeMap(volumeMap) {
  const noisy = [];
  const cleanVolumeMap = {};
  if (volumeMap.none) cleanVolumeMap.none = [...volumeMap.none];

  // Non-numeric volume labels (e.g. "Specials") aren't part of the monotonic
  // chapter-number sequence this function reasons about — pass them through
  // untouched rather than silently dropping them.
  for (const [k, chs] of Object.entries(volumeMap)) {
    if (k !== 'none' && Number.isNaN(parseFloat(k))) cleanVolumeMap[k] = [...chs];
  }

  const knownVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .map(([vStr, chs]) => [vStr, parseFloat(vStr), chs])
    .filter(([, vNum]) => !Number.isNaN(vNum))
    .sort((a, b) => a[1] - b[1]);

  // Pass 1: per-volume median/MAD outlier trim (skip fractional "Specials"-like chapters).
  const perVolume = knownVols.map(([vStr, vNum, chs]) => {
    const nums = [];
    const nonNumeric = [];
    for (const c of chs) {
      const n = parseFloat(c);
      if (!Number.isNaN(n) && Number.isInteger(n) && !String(c).includes('.')) nums.push({ raw: c, n });
      else nonNumeric.push(c);
    }
    nums.sort((a, b) => a.n - b.n);
    let inliers = nums;
    let outliers = [];
    if (nums.length >= 3) {
      const mid = nums[Math.floor(nums.length / 2)].n;
      const deviations = nums.map(x => Math.abs(x.n - mid)).sort((a, b) => a - b);
      const mad = deviations[Math.floor(deviations.length / 2)] || 0;
      // Robust band: at least +/-5 chapters, widened by scaled MAD for large volumes.
      const band = Math.max(5, mad * 3);
      inliers = nums.filter(x => Math.abs(x.n - mid) <= band);
      outliers = nums.filter(x => Math.abs(x.n - mid) > band);
    }
    return { vStr, vNum, inliers, outliers, nonNumeric };
  });

  // Pass 2: enforce monotonic, non-overlapping bands across volumes.
  let prevMax = -Infinity;
  for (let i = 0; i < perVolume.length; i++) {
    const cur = perVolume[i];
    const next = perVolume[i + 1];
    const nextMin = next && next.inliers.length ? Math.min(...next.inliers.map(x => x.n)) : Infinity;

    const kept = [];
    for (const x of cur.inliers) {
      if (x.n <= prevMax || x.n >= nextMin) cur.outliers.push(x);
      else kept.push(x);
    }
    cur.inliers = kept;
    if (cur.inliers.length) prevMax = Math.max(prevMax, ...cur.inliers.map(x => x.n));

    const chs = [...cur.inliers.map(x => x.raw), ...cur.nonNumeric];
    if (chs.length) cleanVolumeMap[cur.vStr] = chs;
    for (const x of cur.outliers) noisy.push(x.raw);
  }

  // Pass 3: whole-volume size outlier. A volume more than ~2x the series'
  // typical (median) size almost never reflects a real publisher volume —
  // demote it back to noisy so extrapolateVolumes() can spread it evenly
  // across however many volumes it should actually have spanned, instead of
  // it standing as a single 30+ chapter anchor.
  const sizes = perVolume.map(v => v.inliers.length).filter(n => n > 0).sort((a, b) => a - b);
  if (sizes.length >= 4) {
    const median = sizes[Math.floor(sizes.length / 2)];
    const threshold = Math.max(median * 1.8, median + 8);
    for (const v of perVolume) {
      if (v.inliers.length > threshold) {
        noisy.push(...v.inliers.map(x => x.raw));
        if (v.nonNumeric.length) cleanVolumeMap[v.vStr] = [...v.nonNumeric];
        else delete cleanVolumeMap[v.vStr];
        v.inliers = [];
      }
    }
  }

  return { cleanVolumeMap, noisy };
}

/**
 * Splits a series' chapter rows into { volumeMap, unassigned } — the shared
 * shape consumed by extrapolateVolumes/getVolumeStats. A chapter counts as a
 * real anchor when it carries a non-calculated volume tag, or when it's an
 * already-imported (packaged) chapter whose estimated volume must stay stable
 * across rescans. Everything else is unassigned and needs (re)estimating.
 * Used by mapping.js and the extrapolate-preview/apply API routes so all three
 * build the anchor set identically.
 */
export function buildVolumeMapFromChapters(chapters) {
  const volumeMap = {};
  const unassigned = [];
  for (const c of chapters) {
    const hasRealVolume = c.volume != null && c.volume !== '' && !c.calculated;
    // 'bindery' is a chapter already bound into a CBZ awaiting the next library
    // scan to flip it to 'imported' — treat it the same as 'imported' so its
    // volume stays a stable anchor rather than being re-estimated mid-flight.
    if (hasRealVolume) {
      (volumeMap[c.volume] ||= []).push(c.number);
    } else if ((c.state === 'imported' || c.state === 'bindery') && c.volume) {
      (volumeMap[c.volume] ||= []).push(c.number);
    } else {
      unassigned.push(c.number);
    }
  }
  return { volumeMap, unassigned };
}

/**
 * Returns stats about the volume map useful for detecting outliers.
 * { lastConsecutive, avgChsPerVol, consecutiveVolSet }
 */
export function getVolumeStats(rawVolumeMap) {
  const { cleanVolumeMap: volumeMap } = sanitizeVolumeMap(rawVolumeMap);
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
  // Median rather than mean: a single oversized volume (a bad/rare provider tag
  // spanning way more chapters than the rest) would otherwise drag the average up
  // and inflate every subsequently-estimated volume, compounding the bad tag's
  // damage instead of containing it.
  const counts = consecutiveVols.map(([, chs]) => chs.length).sort((a, b) => a - b);
  const avgChsPerVol = counts.length > 0
    ? (counts.length % 2 === 1
        ? counts[(counts.length - 1) / 2]
        : Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2))
    : 10;
  const consecutiveVolSet = new Set(consecutiveVols.map(([k]) => String(parseFloat(k))));

  return { lastConsecutive, avgChsPerVol, consecutiveVolSet };
}

/**
 * Extrapolates missing volumes from known volume/chapter anchor points.
 *
 * For any unassigned chapter:
 *  1. Finds the nearest preceding anchor volume (maxCh < chNum).
 *  2. Finds the nearest succeeding anchor volume (minCh > chNum), if any.
 *  3. If both anchors exist, the chapters strictly between them are spread
 *     *evenly* across the volume slots available between the two anchor
 *     volumes (see localChsPerVol below) rather than walking forward with a
 *     single chsPerVol and clamping overshoot into the last slot before the
 *     next anchor — that clamp is what used to dump dozens of chapters into
 *     one volume whenever known anchors were sparse (e.g. only volume 1 and
 *     volume 10 tagged by the provider, with 90 untagged chapters between).
 *  4. If there's no succeeding anchor (tail of the series), estimated volume
 *     = baseVol + ceil((chNum - anchorCh) / chsPerVol), open-ended.
 *
 * Returns { calculated, overflow }
 */
export function extrapolateVolumes(rawVolumeMap, unassignedChapters, totalVolumesHint = null, capAtHint = true, chsPerVolOverride = null) {
  // Reject anchor chapters that don't fit their volume's cluster or that overlap
  // a neighboring volume — a single mistagged chapter must not corrupt every
  // boundary derived from it. Rejected chapters rejoin the unassigned pool so
  // they get a fresh, consistent estimate instead of keeping a bad tag.
  const { cleanVolumeMap: volumeMap, noisy } = sanitizeVolumeMap(rawVolumeMap);
  const effectiveUnassigned = noisy.length ? [...unassignedChapters, ...noisy] : unassignedChapters;
  if (!effectiveUnassigned.length) return { calculated: {}, overflow: [] };

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

      // The historical average only reflects the *tagged* volumes, which for an
      // ongoing series (MangaDex commonly only tags early volumes) can be a
      // poor predictor of how many chapters are actually left to fit into the
      // remaining volumes. When we know the series' real total volume count
      // (e.g. from MangaUpdates) and there's still runway left after the last
      // anchor, derive the tail's chsPerVol from that instead — this is what
      // keeps the *last* estimated volume roughly matching the known total
      // rather than drifting far past (or stopping far short of) it.
      if (totalVolumesHint) {
        const lastAnchor = anchors.reduce((best, a) => (!best || a.volNum > best.volNum ? a : best), null);
        const lastAnchorVol = lastAnchor ? Math.floor(lastAnchor.volNum) : 0;
        const lastAnchorCh = lastAnchor ? lastAnchor.maxCh : 0;
        const remainingVols = totalVolumesHint - lastAnchorVol;
        if (remainingVols > 0) {
          const maxUnassignedCh = Math.max(0, ...effectiveUnassigned.map(c => parseFloat(c)).filter(n => !Number.isNaN(n) && Number.isInteger(n)));
          if (maxUnassignedCh > lastAnchorCh) {
            chsPerVol = Math.max(1, Math.ceil((maxUnassignedCh - lastAnchorCh) / remainingVols));
          }
        }
      }
    }
    anchors.sort((a, b) => a.maxCh - b.maxCh);
  }

  const sortedUnassigned = [...effectiveUnassigned].sort((a, b) => parseFloat(a) - parseFloat(b));
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
    let nextVol = Infinity, nextMinCh = Infinity;

    for (let j = 0; j < anchors.length; j++) {
      if (anchors[j].maxCh < chNum) {
        baseVol = anchors[j].volNum;
        anchorCh = anchors[j].maxCh;
      }
      if (anchors[j].minCh > chNum && anchors[j].volNum < nextVol) {
        nextVol = anchors[j].volNum;
        nextMinCh = anchors[j].minCh;
      }
    }
    baseVol = Math.floor(baseVol);

    let estVol;
    if (nextVol < Infinity) {
      const boundedNextVol = Math.floor(nextVol);
      // Number of whole volume "slots" strictly between the two anchors, and how
      // many unassigned chapters have to fit in them. Sizing chsPerVol to this
      // local gap (instead of a single global average) guarantees every slot gets
      // a fair share instead of the last one absorbing whatever the global rate
      // couldn't fit before hitting the next anchor.
      const slots = Math.max(1, boundedNextVol - baseVol - 1);
      const gapChapters = Math.max(1, nextMinCh - anchorCh - 1);
      let localChsPerVol = chsPerVolOverride || Math.ceil(gapChapters / slots);
      if (localChsPerVol * slots < gapChapters) localChsPerVol = Math.ceil(gapChapters / slots);

      const diff = Math.max(1, chNum - anchorCh);
      estVol = baseVol + Math.max(1, Math.ceil(diff / localChsPerVol));
      estVol = Math.min(estVol, boundedNextVol - 1);
    } else {
      const diff = Math.max(1, chNum - anchorCh);
      estVol = baseVol + Math.max(1, Math.ceil(diff / chsPerVol));
    }

    if (capAtHint && totalVolumesHint && estVol > totalVolumesHint) {
      overflow.push(chStr);
    } else {
      (calculated[String(estVol)] ||= []).push(chStr);
    }
  }

  return { calculated, overflow };
}
