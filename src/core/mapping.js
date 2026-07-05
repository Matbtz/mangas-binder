import { extrapolateVolumes, sanitizeVolumeMap, buildVolumeMapFromChapters } from './extrapolate.js';
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
  const { noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint });
  if (!unassigned.length && !noisy.length) return { assigned: 0 };

  const { calculated } = extrapolateVolumes(volumeMap, unassigned, totalVolumesHint, false, chaptersPerVolume, series.total_chapters_hint || null);

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
