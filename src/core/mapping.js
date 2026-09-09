import { extrapolateVolumes, sanitizeVolumeMap, buildVolumeMapFromChapters } from './extrapolate.js';
import { logHistory } from './db.js';
import { getSeries, listChaptersForSeries } from './repo.js';
import { getDb } from './db.js';
import { getSetting } from './settings.js';

/**
 * Resolve a volume number for every chapter of a series.
 *
 * Provider-tagged volumes are authoritative *unless* they're statistically
 * inconsistent with the rest of that volume or overlap a neighboring volume
 * (see extrapolate.js sanitizeVolumeMap) — a single mistagged chapter from a
 * scanlation group is demoted back to "untagged" rather than trusted outright.
 * Chapters the source left untagged (very common for English scanlations), plus
 * any demoted noisy tags, are assigned to *estimated* volumes via extrapolate.js,
 * seeded by the remaining real volumes and the MangaUpdates total-volume hint.
 * Estimated assignments are flagged `calculated = 1` so the CBZ's ComicInfo.xml
 * notes that the volume boundary is an estimate.
 *
 * Only chapters that aren't already packaged (state 'imported' or 'bindery')
 * are (re)assigned, so volumes already bound into a CBZ — or awaiting the next
 * library scan to be marked as such — keep their boundaries stable across
 * rescans.
 *
 * @returns {{ assigned: number }}  count of chapters given an estimated volume
 */
export function resolveVolumes(seriesId, { chaptersPerVolume = null } = {}) {
  if (!getSetting('extrapolateVolumes', true)) return { assigned: 0 };

  const series = getSeries(seriesId);
  if (!series) return { assigned: 0 };

  // An operator-pinned even split wins over every provider and every estimate —
  // that is the entire point of setting one. Re-applying it here (rather than
  // only at the moment the operator clicks Apply) is what makes it survive: a
  // scheduled refresh that discovers new chapters folds them into the same
  // layout instead of quietly handing the series back to the estimator.
  if (manualDistributionOf(series)) return applyManualDistribution(seriesId);

  const chapters = listChaptersForSeries(seriesId);
  const byNumber = new Map(chapters.map(c => [c.number, c]));

  // Authoritative base map (real tags + already-imported estimated volumes) and
  // the pool of chapters that still need a volume.
  const { volumeMap, unassigned } = buildVolumeMapFromChapters(chapters);

  // Even when every chapter already carries a volume tag, a single mistagged
  // chapter (e.g. a scanlation group's bad "Volume 2" label on chapter 54), or
  // a whole tag numbered past the series' real volume total (a poison anchor —
  // see sanitizeVolumeMap Pass 0), can still corrupt the anchor set. Pass the
  // volume-total hint so those over-cap tags are detected here too, otherwise a
  // fully-tagged-but-polluted series (nothing "unassigned") would early-return
  // and never self-heal on refresh.
  const totalVolumesHint = series.total_volumes_hint || null;
  const totalChaptersHint = series.total_chapters_hint || null;
  const { noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint, totalChaptersHint });
  if (!unassigned.length && !noisy.length) return { assigned: 0 };

  const { calculated } = extrapolateVolumes(volumeMap, unassigned, totalVolumesHint, false, chaptersPerVolume, totalChaptersHint);

  const upd = getDb().prepare(
    "UPDATE chapters SET volume = ?, calculated = 1, updated_at = datetime('now') WHERE id = ? AND (state NOT IN ('imported', 'bindery') OR volume IS NULL OR volume = '')"
  );
  let assigned = 0;
  const isPackaged = c => c.state === 'imported' || c.state === 'bindery';
  for (const [vol, nums] of Object.entries(calculated)) {
    for (const n of nums) {
      const c = byNumber.get(n);
      if (c && (!isPackaged(c) || c.volume == null || c.volume === '')) { upd.run(vol, c.id); assigned++; }
    }
  }
  return { assigned };
}

/**
 * The operator-pinned split for a series, or null when it runs on automatic.
 * @returns {{ totalChapters: number, totalVolumes: number } | null}
 */
export function manualDistributionOf(series) {
  const totalChapters = Number(series?.manual_total_chapters);
  const totalVolumes = Number(series?.manual_total_volumes);
  if (!(totalChapters > 0) || !(totalVolumes > 0)) return null;
  return { totalChapters: Math.floor(totalChapters), totalVolumes: Math.floor(totalVolumes) };
}

/**
 * Volume number for one chapter under a pinned "N chapters over V volumes" split.
 *
 * Purely a function of (chapter, N, V) — it never looks at what else is in the
 * database. That is deliberate: the assignment is then identical on every run,
 * so repeated refreshes can't drift the boundaries, and a chapter the provider
 * adds beyond N lands in the final volume rather than reshaping everything
 * before it. Fractional chapters aren't part of the numbered sequence and are
 * reported as Specials.
 *
 * @returns {string} a volume number, or 'Specials'
 */
export function manualVolumeFor(chapterNumber, totalChapters, totalVolumes) {
  const n = parseFloat(chapterNumber);
  if (!Number.isFinite(n)) return 'Specials';
  if (!Number.isInteger(n) || String(chapterNumber).includes('.')) return 'Specials';
  const V = Math.max(1, Math.floor(totalVolumes));
  const N = Math.max(1, Math.floor(totalChapters));
  return String(Math.min(V, Math.max(1, Math.ceil((n * V) / N))));
}

/**
 * Write the pinned even split across the series' chapters.
 *
 * Chapters already packaged into a CBZ ('imported'/'bindery') keep the volume
 * their file was built with — reassigning them here would desync the DB from
 * what is on disk, the same protection the automatic path applies.
 *
 * @returns {{ assigned: number, skippedPackaged: number }}
 */
export function applyManualDistribution(seriesId) {
  const series = getSeries(seriesId);
  const manual = manualDistributionOf(series);
  if (!manual) return { assigned: 0, skippedPackaged: 0 };

  const upd = getDb().prepare(
    "UPDATE chapters SET volume = ?, calculated = 1, updated_at = datetime('now') WHERE id = ?"
  );
  let assigned = 0, skippedPackaged = 0;
  for (const c of listChaptersForSeries(seriesId)) {
    if (c.state === 'imported' || c.state === 'bindery') {
      if (c.volume != null && c.volume !== '') { skippedPackaged++; continue; }
    }
    const vol = manualVolumeFor(c.number, manual.totalChapters, manual.totalVolumes);
    if (String(c.volume ?? '') === vol) continue;
    upd.run(vol, c.id);
    assigned++;
  }
  if (assigned) {
    logHistory('series.manual_distribution', {
      seriesId,
      message: `${assigned} chapter(s) re-spread over ${manual.totalVolumes} volume(s) (manual ${manual.totalChapters}ch/${manual.totalVolumes}vol)`,
    });
  }
  return { assigned, skippedPackaged };
}
