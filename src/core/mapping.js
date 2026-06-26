import { extrapolateVolumes } from './extrapolate.js';
import { getSeries, listChaptersForSeries } from './repo.js';
import { getDb } from './db.js';
import { getSetting } from './settings.js';

/**
 * Resolve a volume number for every chapter of a series.
 *
 * Provider-tagged volumes are always authoritative. Chapters the source left
 * untagged (very common for English scanlations) are assigned to *estimated*
 * volumes via extrapolate.js, seeded by the real volumes and the MangaUpdates
 * total-volume hint. Estimated assignments are flagged `calculated = 1` so the
 * CBZ's ComicInfo.xml notes that the volume boundary is an estimate.
 *
 * Only non-imported chapters are (re)assigned, so volumes already packaged keep
 * their boundaries stable across rescans.
 *
 * @returns {{ assigned: number }}  count of chapters given an estimated volume
 */
export function resolveVolumes(seriesId) {
  if (!getSetting('extrapolateVolumes', true)) return { assigned: 0 };

  const series = getSeries(seriesId);
  if (!series) return { assigned: 0 };

  const chapters = listChaptersForSeries(seriesId);

  // Authoritative base map (real tags + already-imported estimated volumes) and
  // the pool of chapters that still need a volume.
  const volumeMap = {};
  const unassigned = [];
  const byNumber = new Map();
  for (const c of chapters) {
    byNumber.set(c.number, c);
    const hasRealVolume = c.volume != null && c.volume !== '' && !c.calculated;
    if (hasRealVolume) {
      (volumeMap[c.volume] ||= []).push(c.number);
    } else if (c.state === 'imported' && c.volume) {
      // keep a previously-packaged estimated volume as part of the baseline
      (volumeMap[c.volume] ||= []).push(c.number);
    } else {
      unassigned.push(c.number);
    }
  }

  if (!unassigned.length) return { assigned: 0 };

  const { calculated } = extrapolateVolumes(volumeMap, unassigned, series.total_volumes_hint || null, false);

  const upd = getDb().prepare(
    "UPDATE chapters SET volume = ?, calculated = 1, updated_at = datetime('now') WHERE id = ? AND (state != 'imported' OR volume IS NULL OR volume = '')"
  );
  let assigned = 0;
  for (const [vol, nums] of Object.entries(calculated)) {
    for (const n of nums) {
      const c = byNumber.get(n);
      if (c && (c.state !== 'imported' || c.volume == null || c.volume === '')) { upd.run(vol, c.id); assigned++; }
    }
  }
  return { assigned };
}
