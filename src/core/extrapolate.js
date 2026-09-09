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
 *  4. Discards a whole *sparse* anchor set whose implied per-volume density
 *     contradicts the consensus (a couple of stale tags far apart).
 *  5. Trims the thin anchors out of a *partial* map — one that tags many
 *     volumes but only a sliver of each. Observed on Bleach: MangaUpdates'
 *     release feed tagged 43 volumes, 20 of them with a single chapter, and a
 *     one-chapter anchor is a data point inside a volume, not its boundary.
 *  6. Reopens a *hole* in an otherwise complete map — a volume number the
 *     source skipped entirely, which would otherwise be published as an empty
 *     tome (Bleach again: Wikipedia jumps from volume 35 to 37).
 *
 * Returns { cleanVolumeMap, noisy } where `noisy` is the flat list of
 * chapter numbers (strings) that were pulled out of their volume.
 *
 * When `totalVolumesHint` is supplied (the cross-provider consensus count), any
 * volume tag numbered *beyond* that total is treated as impossible for THIS
 * series and demoted to `noisy` up front — see Pass 0 below. Passes 4-6 need
 * `totalChaptersHint` too: each judges the anchor set against how big a volume
 * of THIS series should be, which is exactly what the two totals say.
 */
// A realistic tankōbon collects a handful to a few dozen chapters; a density
// outside this band between two tagged volumes is physically impossible (mirrors
// volume-consensus.js, kept local to avoid importing the settings chain).
const MIN_CHS_PER_VOL = 2;
const MAX_CHS_PER_VOL = 40;

// A tagged set covering at least this share of the series' chapters is treated
// as a complete volume map (every volume genuinely tagged), so Pass 5's
// partial-map trim stands down — a densely-tagged series' small volumes are real.
const PARTIAL_COVERAGE_LIMIT = 0.85;

// An anchor holding at least this share of an expected volume is "well covered"
// enough for its first/last chapter to be trusted as the volume's actual
// boundary; below it the anchor still says "this chapter is in volume N" but not
// "volume N starts/ends here".
const STRONG_ANCHOR_COVERAGE = 0.6;

export function sanitizeVolumeMap(volumeMap, { totalVolumesHint = null, totalChaptersHint = null } = {}) {
  const noisy = [];
  const cleanVolumeMap = {};
  if (volumeMap.none) cleanVolumeMap.none = [...volumeMap.none];

  // Non-numeric volume labels (e.g. "Specials") aren't part of the monotonic
  // chapter-number sequence this function reasons about — pass them through
  // untouched rather than silently dropping them.
  for (const [k, chs] of Object.entries(volumeMap)) {
    if (k !== 'none' && Number.isNaN(parseFloat(k))) cleanVolumeMap[k] = [...chs];
  }

  const allNumericVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .map(([vStr, chs]) => [vStr, parseFloat(vStr), chs])
    .filter(([, vNum]) => !Number.isNaN(vNum))
    .sort((a, b) => a[1] - b[1]);

  // A "Volume 0" (or negative) tag is out of the main 1..N tankōbon sequence —
  // a prologue/promo bucket, not real volume 0 of the run (a real case: Fool
  // Night surfaced a lone "vol 0" chapter). Route it to Specials instead of
  // seeding a phantom integer anchor, per the report's out-of-sequence guidance.
  const specialsFromZero = [];
  const inSequenceVols = [];
  for (const entry of allNumericVols) {
    if (entry[1] <= 0) specialsFromZero.push(...entry[2]);
    else inSequenceVols.push(entry);
  }
  if (specialsFromZero.length) {
    cleanVolumeMap['Specials'] = [...(cleanVolumeMap['Specials'] || []), ...specialsFromZero];
  }

  // Pass 0: reject volume tags numbered beyond the series' known total. A tag
  // like "Volume 89" on a finished 5-volume series (real case: "Pet", whose DB
  // was polluted by a since-fixed cross-series MangaUpdates release override and
  // by legacy unbounded extrapolation) is physically impossible for THIS title.
  // Each such tag is individually small and monotonically ordered, so passes 1–3
  // below never see a per-chapter or overlap anomaly to reject it — it would
  // survive as a poison anchor and drag the whole breakdown out to volume 89.
  // Demote them to `noisy` here, before they can seed anchors, so
  // extrapolateVolumes re-estimates their chapters back inside [1..hint].
  const volCap = totalVolumesHint > 0 ? Math.floor(totalVolumesHint) : null;
  const knownVols = [];
  for (const entry of inSequenceVols) {
    const [, vNum, chs] = entry;
    if (volCap != null && vNum > volCap) { noisy.push(...chs); continue; }
    knownVols.push(entry);
  }

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

  // Pass 4: sparse-anchor consensus consistency. Passes 1–3 vet each tag against
  // its *neighbors*, but a handful of stale, mutually-consistent-looking tags can
  // still contradict the series' real shape. Real case ("Pet", refreshed): the
  // primary provider tagged zero volumes, yet the DB held cruft anchors from a
  // since-fixed cross-series override — a lone "vol 3" and "vol 5" sitting at
  // chapters 62–63 of a 5-volume/55-chapter series. Each is individually plausible,
  // but the *density between* them (½ a chapter per volume) is impossible, and it
  // pins ~50 untagged chapters into the single slot between vol 1 and vol 3.
  // When we have a confident consensus (both totals) and the anchor set is sparse
  // (few tagged volumes relative to the total), discard the whole set the moment
  // any consecutive pair's implied chapters-per-volume is impossible or wildly off
  // the consensus, so extrapolateVolumes falls back to a clean even split. Only
  // fires when sparse, so a fully-tagged series (Berserk) is never disturbed.
  if (totalVolumesHint > 0 && totalChaptersHint > 0) {
    const anchors = [];
    let intAnchorChapters = 0;
    for (const [vStr, chs] of Object.entries(cleanVolumeMap)) {
      if (vStr === 'none') continue;
      const vNum = parseFloat(vStr);
      if (Number.isNaN(vNum)) continue;
      let maxCh = -Infinity, intCount = 0;
      for (const c of chs) {
        if (String(c).includes('.')) continue;
        const n = parseFloat(c);
        if (Number.isInteger(n)) { intCount++; if (n > maxCh) maxCh = n; }
      }
      if (maxCh > -Infinity) { anchors.push({ vNum, maxCh }); intAnchorChapters += intCount; }
    }
    anchors.sort((a, b) => a.vNum - b.vNum);

    const consensusCPV = totalChaptersHint / totalVolumesHint;
    const sparse = anchors.length <= Math.max(3, Math.ceil(totalVolumesHint * 0.4));
    let inconsistent = false;
    for (let i = 1; i < anchors.length; i++) {
      const volSpan = anchors[i].vNum - anchors[i - 1].vNum;
      if (volSpan <= 0) continue;
      const density = (anchors[i].maxCh - anchors[i - 1].maxCh) / volSpan;
      if (density < MIN_CHS_PER_VOL || density > MAX_CHS_PER_VOL ||
          density < consensusCPV / 2 || density > consensusCPV * 2) { inconsistent = true; break; }
    }
    // Under-populated: the tagged volumes hold far fewer chapters than the
    // consensus says a volume should — i.e. they're *incomplete* tags (Fool
    // Night: a lone "vol 1"=ch2 and "vol 11"=ch93/94, ~1.5 ch/volume against a
    // ~9 consensus). Interpolating between such stubs yields tiny end volumes and
    // a ballooned tail; a consensus even split is strictly better. Full-but-sparse
    // anchors (two genuinely complete volumes tagged far apart) survive.
    const underPopulated = anchors.length > 0 && (intAnchorChapters / anchors.length) < consensusCPV * 0.6;
    if (sparse && (inconsistent || underPopulated)) {
      for (const [vStr, chs] of Object.entries(cleanVolumeMap)) {
        if (vStr !== 'none' && !Number.isNaN(parseFloat(vStr))) { noisy.push(...chs); delete cleanVolumeMap[vStr]; }
      }
    }
  }

  // Pass 5: partial-coverage anchor trim. Pass 4 only fires on a *sparse* anchor
  // set (few tagged volumes); a source can instead tag *many* volumes but only a
  // sliver of each, which is just as destructive and slips straight through.
  // Real case (Bleach): MangaUpdates' release feed mapped 193 of 686 chapters
  // across 43 volumes — a handful complete (9-11 chapters) but 20 of them
  // holding exactly ONE chapter. A one-chapter anchor is not a volume boundary,
  // it is a single data point sitting inside one: it pins its neighbours into the
  // volumes on either side, producing the reported "Vol 8: 1 ch." next to
  // "Vol 28: 25 ch." breakdown.
  //
  // So when the consensus tells us how big a volume should be and the tagged set
  // covers only a fraction of the run, demote the volumes that hold far less than
  // one volume's worth back to `noisy` and let the boundary estimator place their
  // chapters. Volumes that ARE substantially covered stay authoritative anchors,
  // so this sharpens a partial map instead of discarding it (Pass 4's blunter
  // all-or-nothing). Deliberately conservative — it needs both consensus totals,
  // a genuinely partial map, and at least one surviving well-covered anchor.
  if (totalVolumesHint > 0 && totalChaptersHint > 0) {
    const intCountOf = chs => chs.filter(c => !String(c).includes('.') && Number.isInteger(parseFloat(c))).length;
    const numericVols = Object.entries(cleanVolumeMap)
      .filter(([vStr]) => vStr !== 'none' && !Number.isNaN(parseFloat(vStr)))
      .map(([vStr, chs]) => ({ vStr, vNum: parseFloat(vStr), chs, ints: intCountOf(chs) }));

    const taggedInts = numericVols.reduce((n, v) => n + v.ints, 0);
    const coverage = taggedInts / totalChaptersHint;
    const expected = totalChaptersHint / totalVolumesHint;
    // Below this a volume holds less than "a meaningful part of a volume" and is
    // read as an incomplete tag rather than a genuinely short volume.
    const minKeep = Math.max(2, Math.ceil(expected * 0.4));
    const highestVol = numericVols.reduce((m, v) => Math.max(m, v.vNum), 0);

    if (coverage < PARTIAL_COVERAGE_LIMIT) {
      // A volume with zero *integer* chapters (only ".5" omakes) is already not
      // an anchor downstream — leave it be rather than exiling its bonus chapters.
      // The series' final volume is legitimately allowed to be short, so it is
      // never trimmed for being small.
      const weak = numericVols.filter(v => v.ints > 0 && v.ints < minKeep &&
        !(v.vNum === highestVol && v.vNum >= Math.floor(totalVolumesHint)));
      const strong = numericVols.filter(v => v.ints >= minKeep);
      if (strong.length > 0 && weak.length > 0) {
        for (const v of weak) { noisy.push(...v.chs); delete cleanVolumeMap[v.vStr]; }
      }
    }
  }

  // Pass 6: dropped-volume repair, the mirror image of Pass 5. Where Pass 5
  // handles a map that tags many volumes thinly, this handles one that tags
  // nearly every volume fully but skips one outright — a source that lost a row.
  // Live case (Bleach): Wikipedia's chapter lists cover all 686 chapters and 73
  // of the 74 volumes, jumping straight from volume 35 to volume 37. Both
  // neighbours look complete, so they pin their boundaries exactly and leave
  // volume 36 with nothing at all — an empty tome in the library.
  //
  // A hole like that proves the labels bracketing it are wrong (the chapters of
  // the dropped volume were filed under its neighbours), so the two anchors
  // touching the hole are demoted and their chapters re-estimated across all
  // three slots. Only fires on an otherwise complete map with a couple of holes:
  // in a partial map, missing volumes are the norm and mean nothing.
  if (totalVolumesHint > 0 && totalChaptersHint > 0) {
    const numeric = Object.entries(cleanVolumeMap)
      .filter(([vStr]) => vStr !== 'none' && !Number.isNaN(parseFloat(vStr)))
      .map(([vStr, chs]) => ({ vStr, vNum: parseFloat(vStr), chs }))
      .sort((a, b) => a.vNum - b.vNum);
    const tagged = numeric.reduce((n, v) => n + v.chs.length, 0);
    const V = Math.floor(totalVolumesHint);

    if (numeric.length >= 2 && tagged / totalChaptersHint >= PARTIAL_COVERAGE_LIMIT) {
      const present = new Set(numeric.map(v => v.vNum));
      const holes = [];
      for (let v = Math.ceil(numeric[0].vNum) + 1; v < numeric[numeric.length - 1].vNum && v <= V; v++) {
        if (!present.has(v)) holes.push(v);
      }
      if (holes.length && holes.length <= Math.max(2, V * 0.1)) {
        const demote = new Set();
        for (const hole of holes) {
          const below = numeric.filter(v => v.vNum < hole).pop();
          const above = numeric.find(v => v.vNum > hole);
          if (below) demote.add(below.vStr);
          if (above) demote.add(above.vStr);
        }
        for (const vStr of demote) {
          noisy.push(...cleanVolumeMap[vStr]);
          delete cleanVolumeMap[vStr];
        }
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
 *
 * When the tagged sample is too small or too sparse to trust (e.g. the primary
 * provider tagged only a couple of volumes, or none), `avgChsPerVol` falls back
 * to the cross-provider consensus ratio `round(totalChapters / totalVolumes)`
 * rather than a misleading 1-or-2 average — a real case ("Fool Night", 3 tagged
 * chapters against a 12-volume/109-chapter consensus) reported chsPerVol=1.
 */
export function getVolumeStats(rawVolumeMap, { totalVolumesHint = null, totalChaptersHint = null } = {}) {
  const { cleanVolumeMap: volumeMap } = sanitizeVolumeMap(rawVolumeMap, { totalVolumesHint, totalChaptersHint });
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
  //
  // Count only whole-number chapters: a volume whose *only* tags are fractional
  // omakes (".5" bonus chapters — a real case in Centuria, where MangaDex tagged
  // vols 6-9 with just a single "49.5"/"58.5"/… each) is not a real 1-chapter
  // volume, and letting those size-1 entries into the median dragged the reported
  // chapters-per-volume down to 5 for a series that actually runs ~10/vol.
  const counts = consecutiveVols
    .map(([, chs]) => chs.filter(c => !String(c).includes('.') && Number.isInteger(parseFloat(c))).length)
    .filter(n => n > 0)
    .sort((a, b) => a - b);
  const sampledAvg = counts.length > 0
    ? (counts.length % 2 === 1
        ? counts[(counts.length - 1) / 2]
        : Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2))
    : null;

  // The tagged sample only reflects whatever early volumes the primary provider
  // happened to tag. When that sample is thin (fewer than three consecutive
  // tagged volumes) or degenerate (≈1 chapter each), it's a worse predictor of
  // real volume size than the consensus totals — prefer round(chapters/volumes)
  // when both are known.
  const consensusRatio = (totalChaptersHint > 0 && totalVolumesHint > 0)
    ? Math.max(1, Math.round(totalChaptersHint / totalVolumesHint))
    : null;
  let avgChsPerVol = sampledAvg ?? consensusRatio ?? 10;
  if (consensusRatio && (counts.length < 3 || avgChsPerVol < 3)) avgChsPerVol = consensusRatio;

  const consecutiveVolSet = new Set(consecutiveVols.map(([k]) => String(parseFloat(k))));

  return { lastConsecutive, avgChsPerVol, consecutiveVolSet };
}

/**
 * Split an ordered chapter list into exactly `volumeCount` evenly-sized volumes.
 *
 * Rank-based rather than number-based on purpose: a hole in the numbering (a
 * delisted arc) or a stray out-of-range chapter must not drag the split apart.
 * Fractional chapters (".5" omakes) go to Specials instead of consuming a slot
 * in the main sequence.
 *
 * This is the primitive behind the manual "N chapters over V volumes" mode and
 * the no-anchor fallback below.
 *
 * @param {Array<string|number>} chapters
 * @param {number} volumeCount
 * @returns {{ [volume: string]: string[] }}
 */
export function evenVolumeSplit(chapters, volumeCount) {
  const out = {};
  const V = Math.max(1, Math.floor(volumeCount));
  const integers = [];
  for (const c of chapters) {
    const n = parseFloat(c);
    if (Number.isNaN(n)) continue;
    if (String(c).includes('.') || !Number.isInteger(n)) { (out['Specials'] ||= []).push(String(c)); continue; }
    integers.push({ raw: String(c), n });
  }
  integers.sort((a, b) => a.n - b.n);
  const N = integers.length;
  integers.forEach(({ raw }, i) => {
    const v = N ? Math.min(V, Math.floor((i * V) / N) + 1) : 1;
    (out[String(v)] ||= []).push(raw);
  });
  return out;
}

/**
 * Extrapolates missing volumes from known volume/chapter anchor points.
 *
 * The estimator works on volume *boundaries*, not on one chapter at a time.
 * Every chapter — tagged or not — is laid out on a single ordered axis, and the
 * job is to choose the V-1 cut positions that carve it into volumes:
 *
 *  1. Each anchor volume constrains the cuts around it. A *well-covered* anchor
 *     (see STRONG_ANCHOR_COVERAGE) holds enough of a volume for its first and
 *     last chapter to BE that volume's boundaries, so its two cuts are pinned
 *     exactly. A thinly-covered anchor only says "this chapter sits in volume N"
 *     and merely constrains the cuts to contain it.
 *  2. Between two pinned cuts the chapters are spread *evenly* over the volume
 *     slots in between, then clamped back inside whatever the thin anchors
 *     require. Volumes therefore come out uniform by construction.
 *  3. The volume count is the consensus total when known, otherwise the last
 *     anchored volume plus however many more `chsPerVol` needs for the tail.
 *
 * Why this shape: the previous estimator walked each chapter out from its
 * nearest anchor, so a thin anchor (one chapter tagged inside a volume) pinned
 * its neighbours into the volumes on either side and starved its own. Against
 * MangaUpdates' Bleach release feed — 43 tagged volumes, 20 of them holding a
 * single chapter — that produced the reported "Vol 8: 1 ch." beside
 * "Vol 28: 25 ch." breakdown. Choosing boundaries instead makes an even
 * distribution the default and a lopsided one only possible when the anchors
 * genuinely demand it.
 *
 * Special case — *no* usable anchors but a known total volume count: the
 * chapters are distributed across exactly that many volumes (by chapter number
 * when totalChaptersHint is known, otherwise by rank), which is bounded,
 * gapless and even. This is the common English-scanlation case where the
 * source tags no volumes at all.
 *
 * @param {number|null} totalChaptersHint  the series' resolved total chapter
 *   count (from the cross-provider consensus); anchors chapter→volume spacing
 *   for the no-anchor case so it survives sparse/noisy chapter numbering.
 * Returns { calculated, overflow }
 */
export function extrapolateVolumes(rawVolumeMap, unassignedChapters, totalVolumesHint = null, capAtHint = true, chsPerVolOverride = null, totalChaptersHint = null) {
  // Reject anchor chapters that don't fit their volume's cluster or that overlap
  // a neighboring volume — a single mistagged chapter must not corrupt every
  // boundary derived from it. Rejected chapters rejoin the unassigned pool so
  // they get a fresh, consistent estimate instead of keeping a bad tag.
  const { cleanVolumeMap: volumeMap, noisy } = sanitizeVolumeMap(rawVolumeMap, { totalVolumesHint, totalChaptersHint });
  const effectiveUnassigned = noisy.length ? [...unassignedChapters, ...noisy] : unassignedChapters;
  if (!effectiveUnassigned.length) return { calculated: {}, overflow: [] };

  const knownVols = Object.entries(volumeMap)
    .filter(([k]) => k !== 'none')
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  let chsPerVol = chsPerVolOverride || 10;
  const anchors = []; // [{ volNum, minCh, maxCh, size }] — integer chapters only

  for (const [vStr, chs] of knownVols) {
    const vNum = parseFloat(vStr);
    if (Number.isNaN(vNum)) continue;
    let minCh = Infinity, maxCh = -Infinity, size = 0;
    for (const c of chs) {
      if (String(c).includes('.')) continue; // fractional chapters never define a boundary
      const cNum = parseFloat(c);
      if (!Number.isNaN(cNum) && Number.isInteger(cNum)) {
        if (cNum < minCh) minCh = cNum;
        if (cNum > maxCh) maxCh = cNum;
        size++;
      }
    }
    if (maxCh > -Infinity) anchors.push({ volNum: vNum, minCh, maxCh, size });
  }

  if (anchors.length > 0 && !chsPerVolOverride) {
    const stats = getVolumeStats(volumeMap, { totalVolumesHint, totalChaptersHint });
    chsPerVol = stats.avgChsPerVol || 10;
    if (chsPerVol < 3) chsPerVol = 10; // safety clamp: sparse/erroneous metadata must not mint 1-chapter volumes
  }
  anchors.sort((a, b) => a.volNum - b.volNum);

  // Split the pool: whole chapters take part in the boundary layout, fractional
  // ones are Specials, and anything unparseable overflows.
  const sortedUnassigned = [...effectiveUnassigned].sort((a, b) => parseFloat(a) - parseFloat(b));
  const calculated = {};
  const overflow = [];
  const freeRaw = new Map(); // chapterNumber -> the original string form
  for (const chStr of sortedUnassigned) {
    const chNum = parseFloat(chStr);
    if (Number.isNaN(chNum)) { overflow.push(chStr); continue; }
    if (String(chStr).includes('.') || !Number.isInteger(chNum)) { (calculated['Specials'] ||= []).push(chStr); continue; }
    if (!freeRaw.has(chNum)) freeRaw.set(chNum, chStr);
  }

  // No usable volume anchors at all (e.g. an English scanlation source that
  // tags nothing, like Pet on MangaKatana), but we DO know the series' real
  // total volume count. Distribute the chapters across exactly that many
  // volumes so the result is bounded, gapless and evenly sized — instead of
  // the old `ceil(chapterNumber / 10)`, which invented unbounded phantom
  // volumes from sparse or noisy chapter numbering (a finished 5-volume,
  // 55-chapter series was landing chapters in volumes as high as 120).
  if (anchors.length === 0) {
    const integers = [...freeRaw.entries()].map(([n, raw]) => ({ n, raw })).sort((a, b) => a.n - b.n);
    if (!(totalVolumesHint >= 1)) {
      // Nothing at all to bound against: fall back to the historical rate-based
      // numbering (volume = ceil(chapter / chsPerVol)).
      for (const { n, raw } of integers) {
        (calculated[String(Math.max(1, Math.ceil(n / chsPerVol)))] ||= []).push(raw);
      }
      return { calculated, overflow };
    }
    const V = Math.floor(totalVolumesHint);
    // Prefer number-based spacing when we also know the real chapter total: it
    // keeps every chapter at its true position and folds any stray
    // out-of-range chapter into the final known volume rather than past it.
    // Without a chapter total — or when the actual run has grown meaningfully
    // past that total (a slightly-stale consensus for an ongoing series, or a
    // finished series the primary provider lists a few chapters beyond) — fall
    // back to rank-based distribution, which is immune to gaps/outliers in the
    // numbering (a stray "chapter 1190" can't drag the split apart) and, crucially,
    // does not clamp every trailing chapter past the total into the final volume
    // (which would balloon it — e.g. 64 real chapters against a 55-chapter
    // consensus dumping chapters 56–64 all into volume 5).
    const maxIntCh = integers.length ? integers[integers.length - 1].n : 0;
    const withinTotal = totalChaptersHint && totalChaptersHint > 0 && maxIntCh <= totalChaptersHint * 1.1;
    if (chsPerVolOverride && chsPerVolOverride > 0) {
      // Explicit rate requested (manual "extrapolate to volume N"): honour it.
      for (const { n, raw } of integers) {
        (calculated[String(Math.min(V, Math.max(1, Math.ceil(n / chsPerVolOverride))))] ||= []).push(raw);
      }
    } else if (withinTotal && maxIntCh > 0) {
      // Place each chapter by its fractional position in the run so all V volumes
      // are used and each is evenly sized — `ceil(n / ceil(total/V))` used to leave
      // the final volume empty and overload the penultimate one whenever the total
      // didn't divide evenly (109 chapters / 12 volumes landed everything in 1-11).
      for (const { n, raw } of integers) {
        (calculated[String(Math.min(V, Math.max(1, Math.floor(((n - 1) * V) / maxIntCh) + 1)))] ||= []).push(raw);
      }
    } else {
      for (const [vol, chs] of Object.entries(evenVolumeSplit(integers.map(x => x.raw), V))) {
        (calculated[vol] ||= []).push(...chs);
      }
    }
    return { calculated, overflow };
  }

  // --- Boundary layout ------------------------------------------------------
  // The axis is every whole chapter, anchored and free alike, in reading order.
  const axis = [...new Set([
    ...anchors.flatMap(a => [a.minCh, a.maxCh]),
    ...knownVols.flatMap(([, chs]) => chs.map(c => parseFloat(c)).filter(n => Number.isInteger(n) && !Number.isNaN(n))),
    ...freeRaw.keys(),
  ])].sort((a, b) => a - b);

  const lastAnchor = anchors[anchors.length - 1];
  const maxAnchorVol = Math.floor(lastAnchor.volNum);
  const maxAnchorCh = anchors.reduce((m, a) => Math.max(m, a.maxCh), -Infinity);
  let V = totalVolumesHint > 0
    ? Math.max(maxAnchorVol, Math.floor(totalVolumesHint))
    : maxAnchorVol + Math.ceil(axis.filter(n => n > maxAnchorCh).length / chsPerVol);
  V = Math.max(1, V);

  // capAtHint: chapters that don't fit in [1..hint] at the going rate are
  // dropped rather than squeezed in (the caller asked for a hard cap).
  if (capAtHint && totalVolumesHint > 0) {
    V = Math.floor(totalVolumesHint);
    const tailStart = axis.findIndex(n => n > maxAnchorCh);
    if (tailStart >= 0) {
      const capacity = Math.max(0, V - maxAnchorVol) * (chsPerVolOverride || chsPerVol);
      const keep = tailStart + capacity;
      for (let i = keep; i < axis.length; i++) {
        const raw = freeRaw.get(axis[i]);
        if (raw != null) { overflow.push(raw); freeRaw.delete(axis[i]); }
      }
      if (keep < axis.length) axis.length = Math.max(0, keep);
    }
  }

  const n = axis.length;
  const pos = new Map(axis.map((ch, i) => [ch, i]));

  // An anchor covering at least STRONG_ANCHOR_COVERAGE of an expected volume is
  // trusted for its *boundaries*; a thinner one only for *membership*.
  const expectedSize = chsPerVolOverride
    || ((totalChaptersHint > 0 && totalVolumesHint > 0) ? totalChaptersHint / totalVolumesHint : chsPerVol);
  const strongMin = Math.max(2, Math.ceil(expectedSize * STRONG_ANCHOR_COVERAGE));

  const lo = new Array(V + 2).fill(0);
  const hi = new Array(V + 2).fill(n);
  for (const a of anchors) {
    const v = Math.floor(a.volNum);
    if (v < 1 || v > V) continue;
    const s = pos.get(a.minCh), e = pos.get(a.maxCh);
    if (s == null || e == null) continue;         // trimmed away by the cap above
    hi[v] = Math.min(hi[v], s);                   // volume v starts at or before its first tagged chapter
    if (v + 1 <= V) lo[v + 1] = Math.max(lo[v + 1], e + 1); // and ends at or after its last
    if (a.size >= strongMin) {
      lo[v] = Math.max(lo[v], s);                 // well covered: those chapters ARE the boundaries
      if (v + 1 <= V) hi[v + 1] = Math.min(hi[v + 1], e + 1);
    }
  }
  lo[1] = 0; hi[1] = 0;                           // volume 1 always starts at the first chapter
  lo[V + 1] = n; hi[V + 1] = n;                   // and the last volume always runs to the end
  for (let v = 2; v <= V; v++) lo[v] = Math.max(lo[v], lo[v - 1]);
  for (let v = V; v >= 1; v--) hi[v] = Math.min(hi[v], hi[v + 1]);
  for (let v = 1; v <= V + 1; v++) if (lo[v] > hi[v]) lo[v] = hi[v];

  // Cuts that the anchors fix exactly; everything between them is filled evenly.
  const pinned = [{ v: 1, idx: 0 }];
  for (let v = 2; v <= V; v++) if (lo[v] === hi[v]) pinned.push({ v, idx: lo[v] });
  pinned.push({ v: V + 1, idx: n });

  const cut = new Array(V + 2).fill(0);
  for (let k = 0; k < pinned.length - 1; k++) {
    const a = pinned[k], b = pinned[k + 1];
    cut[a.v] = a.idx;
    cut[b.v] = b.idx;
    const spanVols = b.v - a.v;
    const spanLen = b.idx - a.idx;
    for (let j = 1; j < spanVols; j++) {
      const even = a.idx + Math.round((j * spanLen) / spanVols);
      cut[a.v + j] = Math.min(hi[a.v + j], Math.max(lo[a.v + j], even));
    }
  }
  for (let v = 2; v <= V + 1; v++) if (cut[v] < cut[v - 1]) cut[v] = cut[v - 1];

  let vol = 1;
  for (let i = 0; i < n; i++) {
    while (vol < V && cut[vol + 1] <= i) vol++;
    const raw = freeRaw.get(axis[i]);
    if (raw != null) (calculated[String(vol)] ||= []).push(raw);
  }

  return { calculated, overflow };
}
