import { getProvider, defaultDownloadProvider } from '../providers/index.js';
import { fetchChapterVolumeMap } from '../providers/mangaupdates.js';
import { consultVolumeProviders } from './volume-consensus.js';
import {
  createSeries, getSeries, updateSeries, touchSeriesScan,
  upsertChapter, chapterStateCounts, listChaptersForSeries, bulkSetChapterState,
} from './repo.js';
import { isProviderEnabled, getSetting } from './settings.js';
import { scanLibrary } from './library-scan.js';
import { resolveVolumes } from './mapping.js';
import { logHistory } from './db.js';
import { buildVolumeMapFromChapters, sanitizeVolumeMap, getVolumeStats, extrapolateVolumes } from './extrapolate.js';

const PACKAGED_STATES = new Set(['imported', 'bindery']);

/**
 * Follow a new series: fetch metadata from the source, optionally enrich the
 * total-volume hint from MangaUpdates, persist it, then run an initial refresh
 * to populate its chapter list.
 *
 * The follow (metadata) provider only needs `capabilities.metadata`; the *files*
 * come from a separate download/archive provider (same as the metadata provider
 * for manga/MangaDex; GetComics for ComicVine comics).
 *
 * @param {string} providerName     metadata provider (mangadex | comicvine)
 * @param {string} providerSeriesId
 * @param {{ monitorMode?, monitorFromVolume?, packagingMode?, language?, downloadProvider? }} opts
 */
export async function followSeries(providerName, providerSeriesId, opts = {}) {
  const provider = getProvider(providerName);
  if (!isProviderEnabled(providerName)) throw new Error(`Provider ${providerName} is disabled`);
  if (!provider.capabilities.metadata) throw new Error(`Provider ${providerName} has no metadata`);

  const mediaType = provider.mediaType || 'manga';
  const downloadProvider = opts.downloadProvider || defaultDownloadProvider(mediaType);

  const details = await provider.getSeries(providerSeriesId);

  // Volume-count hint (for estimated grouping) only applies to manga, resolved
  // across every enabled total-volume provider (see volume-consensus.js) so a
  // freshly-followed series gets a trustworthy hint from the start rather
  // than whatever a single provider happens to report.
  let totalVolumesHint = null;
  if (mediaType === 'manga') {
    const { totalVolumes } = await consultVolumeProviders(details.title).catch(() => ({ totalVolumes: { value: null } }));
    totalVolumesHint = totalVolumes.value;
  }

  // Comics default to per-issue packaging (collected editions aren't deterministic).
  const defaultPackaging = mediaType === 'comic' ? 'chapter' : getSetting('defaultPackagingMode', 'volume');

  const series = createSeries({
    provider: providerName,
    providerSeriesId,
    mediaType,
    downloadProvider,
    publisher: details.publisher ?? null,
    title: details.title,
    authors: details.authors,
    artists: details.artists,
    genres: details.genres,
    description: details.description,
    year: details.year,
    status: details.status,
    coverPath: details.coverPath ?? null,
    language: opts.language || getSetting('defaultLanguage', 'en'),
    monitored: true,
    monitorMode: opts.monitorMode || getSetting('defaultMonitorMode', 'all'),
    monitorFromVolume: opts.monitorFromVolume ?? null,
    packagingMode: opts.packagingMode || defaultPackaging,
    totalVolumesHint,
  });

  logHistory('series.followed', { seriesId: series.id, message: details.title });
  // Refresh chapters & reconcile against library asynchronously in background
  // so the UI "Follow" button responds instantly (<50ms).
  Promise.resolve().then(async () => {
    try {
      await refreshSeries(series.id);
      await scanLibrary({ seriesId: series.id });
    } catch (err) {
      console.error(`Background refresh failed for followed series ${series.id}:`, err);
    }
  });
  return getSeries(series.id);
}

/**
 * Refresh a series' chapter list from its source. New chapters are inserted as
 * `wanted` (monitor_mode=all) or `skipped` on the first scan (monitor_mode=future,
 * so only chapters released *after* you started following get queued). Existing
 * chapters have their volume/page info refreshed (MangaDex assigns volumes late).
 *
 * @returns {Promise<{ added: number, counts: object }>}
 */
export async function refreshSeries(seriesId) {
  const series = getSeries(seriesId);
  if (!series) throw new Error(`No series ${seriesId}`);
  const provider = getProvider(series.provider);

  const firstScan = !series.last_scan_at;
  const futureOnly = series.monitor_mode === 'future';
  const noneMode = series.monitor_mode === 'none';
  const fromMode = series.monitor_mode === 'from';
  const fromVolume = fromMode && series.monitor_from_volume != null ? parseFloat(series.monitor_from_volume) : null;

  // Backfill a missing cover from the source so the poster grid isn't blank
  // (best-effort; an extra fetch only when we have nothing to show).
  if (!series.cover_path && provider.getSeries) {
    try {
      const details = await provider.getSeries(series.provider_series_id);
      if (details?.coverPath) updateSeries(seriesId, { coverPath: details.coverPath });
    } catch { /* non-fatal */ }
  }

  const chapters = await provider.listChapters(series.provider_series_id, { lang: series.language });

  if (series.media_type === 'manga') {
    try {
      // Cross-check every enabled total-volume/chapter provider instead of
      // trusting MangaUpdates alone (see volume-consensus.js: a real bug had
      // MangaUpdates' own latest_chapter badly stale for an older completed
      // series while AniList/MangaBaka/Fandom all independently agreed on
      // the real number). The resolved consensus both sets the volume hint
      // and bounds how far chapters are gap-filled.
      const { totalVolumes, totalChapters, mangaUpdatesRef } = await consultVolumeProviders(series.title);
      if (totalVolumes.value && series.total_volumes_hint !== totalVolumes.value) {
        updateSeries(seriesId, { totalVolumesHint: totalVolumes.value });
      }
      if (totalChapters.value && totalChapters.value > 0) {
        const knownNums = new Set(chapters.map(c => String(parseFloat(c.number))));
        for (let i = 1; i <= totalChapters.value; i++) {
          if (!knownNums.has(String(i))) {
            chapters.push({
              id: `synth-${seriesId}-${i}`,
              number: String(i),
              volume: null,
              title: `Chapter ${i}`,
              lang: series.language,
            });
          }
        }
      }

      // Cross-check MangaDex's volume tags against MangaUpdates' release records.
      // Each MU release record carries the chapter number AND the volume it
      // belongs to, giving authoritative boundaries for series where the MangaDex
      // aggregate is sparse or its scanlation-group tags are inconsistent (e.g.
      // Dandadan, One Piece English simulpubs). We always fill chapters MangaDex
      // left null, and — since MU volumes reflect official releases rather than
      // per-group tagging — we also prefer MU's value when it *disagrees* with
      // MangaDex for a chapter, rather than only ever filling gaps. (extrapolate.js
      // still sanitizes the result, so this is a second, independent vote, not a
      // blind override.) This per-chapter mapping stays MangaUpdates-exclusive —
      // the other cross-checks only supply total counts, not a chapter-by-chapter
      // breakdown.
      if (mangaUpdatesRef?.seriesId) {
        try {
          const { map: muVolMap } = await fetchChapterVolumeMap(mangaUpdatesRef.seriesId, mangaUpdatesRef.seriesTitle || series.title);
          if (muVolMap.size > 0) {
            for (const ch of chapters) {
              const v = muVolMap.get(String(parseFloat(ch.number)));
              if (v && v !== ch.volume) ch.volume = v;
            }
          }
        } catch { /* non-fatal — proceed without MU volume data */ }
      }
    } catch {}
  }

  let added = 0;
  for (const ch of chapters) {
    let initialState;
    if (noneMode || (futureOnly && firstScan)) {
      initialState = 'skipped';
    } else if (fromMode && fromVolume != null) {
      // Skip chapters whose volume is below the threshold; null-volume chapters
      // are skipped too until a refresh assigns them a real volume number.
      const chVol = ch.volume != null ? parseFloat(ch.volume) : null;
      initialState = (chVol != null && chVol >= fromVolume) ? 'wanted' : 'skipped';
    } else {
      initialState = 'wanted';
    }
    const inserted = upsertChapter(seriesId, {
      provider: series.provider,
      providerChapterId: ch.id,
      number: ch.number,
      volume: ch.volume,
      title: ch.title,
      language: ch.lang || series.language,
      publishedAt: ch.publishedAt,
      pages: ch.pages,
    }, initialState);
    if (inserted && initialState === 'wanted') added++;
  }

  touchSeriesScan(seriesId);
  if (added > 0) logHistory('series.new_chapters', { seriesId, message: `${added} new chapter(s)` });
  // Assign estimated volume numbers to chapters the provider left untagged (e.g.
  // English MangaDex scanlations with no volume, or ComicVine issues). This runs
  // synchronously because it's a fast DB-only pass and ensures volume data is ready
  // before the library scan that follows.
  resolveVolumes(seriesId);

  // monitor_mode='from': chapters that arrived without a volume were skipped above
  // (the threshold can't be judged yet) and were never re-checked. Now that volumes
  // are assigned (provider tags + MangaUpdates + extrapolation), promote any
  // skipped chapter whose volume now meets the threshold, so late-tagged chapters
  // aren't silently left undownloaded.
  if (fromMode && fromVolume != null) {
    const promote = [];
    for (const c of listChaptersForSeries(seriesId)) {
      if (c.state !== 'skipped') continue;
      const v = (c.volume != null && c.volume !== '') ? parseFloat(c.volume) : null;
      if (v != null && v >= fromVolume) promote.push(c.id);
    }
    if (promote.length) {
      bulkSetChapterState(promote, 'wanted', { resetAttempts: true });
      logHistory('series.threshold_promoted', { seriesId, message: `${promote.length} chapter(s) now ≥ vol ${fromVolume} queued` });
    }
  }

  return { added, counts: chapterStateCounts(seriesId) };
}

/**
 * Read-only dry run of refreshSeries(): fetches exactly the same provider data
 * (primary provider + MangaUpdates hint/overrides) but never writes to the DB.
 * Returns a report citing what each provider contributed and what applying a
 * real refresh would change, so the "Refresh" UI can show it before committing.
 *
 * The estimated-volume section re-runs the same buildVolumeMapFromChapters /
 * sanitizeVolumeMap / extrapolateVolumes pipeline resolveVolumes() uses, over a
 * simulated merge of "current DB chapters" + "what the providers just returned"
 * — same math, same anchor/noisy-tag handling, just never persisted.
 */
export async function previewRefreshSeries(seriesId) {
  const series = getSeries(seriesId);
  if (!series) throw new Error(`No series ${seriesId}`);
  const provider = getProvider(series.provider);

  const providersConsulted = [];

  const chapters = await provider.listChapters(series.provider_series_id, { lang: series.language });
  for (const ch of chapters) ch.volumeSource = (ch.volume != null && ch.volume !== '') ? series.provider : null;
  providersConsulted.push({
    name: provider.label || series.provider,
    role: 'primary chapter list & volume tags',
    chaptersReturned: chapters.length,
    chaptersWithVolume: chapters.filter(c => c.volumeSource).length,
  });

  // Cross-check every enabled total-volume/chapter provider and resolve a
  // consensus instead of trusting MangaUpdates alone (see
  // core/volume-consensus.js: MangaUpdates' own latest_chapter has been
  // observed badly stale for an older completed series while
  // AniList/MangaBaka/Fandom all independently agreed on the real number).
  // `mangaUpdates` keeps its historical shape/name here since it also drives
  // the per-chapter volume-override mechanic, which stays MangaUpdates-only.
  let mangaUpdates = null;
  if (series.media_type === 'manga') {
    const { providerReports, totalVolumes, totalChapters, mangaUpdatesRef } = await consultVolumeProviders(series.title);
    providersConsulted.push(...providerReports);

    mangaUpdates = {
      totalVolumesHint: totalVolumes.value,
      totalVolumesConfidence: totalVolumes.confidence,
      totalVolumesAgreeing: totalVolumes.agreeing,
      totalVolumesDissenting: totalVolumes.dissenting,
      latestChapterHint: totalChapters.value,
      latestChapterConfidence: totalChapters.confidence,
      latestChapterAgreeing: totalChapters.agreeing,
      latestChapterDissenting: totalChapters.dissenting,
      gapFilledChapters: 0,
      volumeOverrides: 0,
      releasesChecked: 0,
      releasesVerified: 0,
      releasesRejectedMismatch: 0,
    };

    if (totalChapters.value && totalChapters.value > 0) {
      const knownNums = new Set(chapters.map(c => String(parseFloat(c.number))));
      for (let i = 1; i <= totalChapters.value; i++) {
        if (!knownNums.has(String(i))) {
          chapters.push({ id: `synth-${seriesId}-${i}`, number: String(i), volume: null, volumeSource: null, title: `Chapter ${i}`, lang: series.language });
          mangaUpdates.gapFilledChapters++;
        }
      }
    }

    if (mangaUpdatesRef?.seriesId) {
      try {
        const { map: muVolMap, checked, verified, rejected } = await fetchChapterVolumeMap(mangaUpdatesRef.seriesId, mangaUpdatesRef.seriesTitle || series.title);
        mangaUpdates.releasesChecked = checked;
        mangaUpdates.releasesVerified = verified;
        mangaUpdates.releasesRejectedMismatch = rejected;
        for (const ch of chapters) {
          const v = muVolMap.get(String(parseFloat(ch.number)));
          if (v && v !== ch.volume) { ch.volume = v; ch.volumeSource = 'mangaupdates'; mangaUpdates.volumeOverrides++; }
        }
      } catch { mangaUpdates.volumeMapError = true; }
    }

    providersConsulted.push({
      name: 'Consensus',
      role: 'resolved total-volume/chapter count across all providers above',
      totalVolumesHint: mangaUpdates.totalVolumesHint,
      totalVolumesConfidence: mangaUpdates.totalVolumesConfidence,
      latestChapterHint: mangaUpdates.latestChapterHint,
      latestChapterConfidence: mangaUpdates.latestChapterConfidence,
      gapFilledChapters: mangaUpdates.gapFilledChapters,
      volumeOverrides: mangaUpdates.volumeOverrides,
      releasesRejectedAsMismatch: mangaUpdates.releasesRejectedMismatch,
    });
  }

  // --- Diff against what's currently in the DB ---
  const existing = listChaptersForSeries(seriesId);
  const existingByNumber = new Map(existing.map(c => [c.number, c]));
  const newChapters = [];
  const volumeChanges = [];
  const protectedSkipped = [];

  for (const ch of chapters) {
    const cur = existingByNumber.get(String(ch.number));
    if (!cur) {
      if (ch.volume != null && ch.volume !== '') newChapters.push({ number: ch.number, volume: ch.volume, source: ch.volumeSource });
      continue;
    }
    const curVol = cur.volume ?? null;
    const candVol = ch.volume ?? null;
    if (candVol == null || candVol === curVol) continue;
    if (PACKAGED_STATES.has(cur.state)) {
      protectedSkipped.push({ number: ch.number, dbVolume: curVol, providerVolume: candVol, source: ch.volumeSource });
    } else {
      volumeChanges.push({ number: ch.number, from: curVol, to: candVol, source: ch.volumeSource });
    }
  }

  // --- Simulate resolveVolumes()'s extrapolation over the merged pool ---
  const mergedByNumber = new Map(existing.map(c => [c.number, { ...c }]));
  for (const ch of chapters) {
    const key = String(ch.number);
    const cur = mergedByNumber.get(key);
    if (cur) {
      if (!PACKAGED_STATES.has(cur.state) && ch.volume != null && ch.volume !== '') { cur.volume = ch.volume; cur.calculated = 0; }
    } else {
      mergedByNumber.set(key, { number: key, volume: ch.volume ?? null, calculated: 0, state: 'wanted' });
    }
  }
  const mergedChapters = [...mergedByNumber.values()];
  const { volumeMap, unassigned } = buildVolumeMapFromChapters(mergedChapters);
  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap);
  const stats = getVolumeStats(volumeMap);
  const totalVolumesHint = series.total_volumes_hint || mangaUpdates?.totalVolumesHint || null;
  const { calculated, overflow } = extrapolateVolumes(volumeMap, unassigned, totalVolumesHint, false, null);

  // Use the *sanitized* map here, not the raw one: extrapolateVolumes() already
  // re-sanitizes internally and reassigns noisy/outlier-volume chapters to a
  // corrected slot inside `calculated`. Building this from the raw volumeMap
  // would double-count those chapters (once under their rejected original
  // volume, once under their corrected one) and would make whole-volume
  // outliers that sanitizeVolumeMap already demoted (see its Pass 3) still show
  // up at full size here — silently defeating that safeguard for anyone
  // reading the preview instead of the eventual real refresh.
  const volumeBreakdown = {};
  for (const [v, chs] of Object.entries(cleanVolumeMap)) {
    if (v === 'none') continue;
    volumeBreakdown[v] = (volumeBreakdown[v] || 0) + chs.length;
  }
  for (const [v, chs] of Object.entries(calculated)) {
    volumeBreakdown[v] = (volumeBreakdown[v] || 0) + chs.length;
  }
  const counts = Object.values(volumeBreakdown).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const outlierVolumes = Object.entries(volumeBreakdown)
    .filter(([, count]) => median > 2 && count > median * 2)
    .map(([volume, count]) => ({ volume, count }));

  const TRUNCATE = 50;
  return {
    seriesId,
    seriesTitle: series.title,
    fetchedAt: new Date().toISOString(),
    providersConsulted,
    mangaUpdates,
    summary: {
      currentChapterCount: existing.length,
      incomingChapterCount: chapters.length,
      newChapterCount: newChapters.length,
      volumeChangeCount: volumeChanges.length,
      protectedSkippedCount: protectedSkipped.length,
      chsPerVolUsed: stats.avgChsPerVol,
      estimatedVolumeCount: Object.keys(calculated).filter(v => v !== 'Specials').length,
      noisyTagsRejected: noisy.length,
      overflowCount: overflow.length,
    },
    newChapters: newChapters.slice(0, TRUNCATE),
    newChaptersTruncated: newChapters.length > TRUNCATE,
    volumeChanges: volumeChanges.slice(0, TRUNCATE),
    volumeChangesTruncated: volumeChanges.length > TRUNCATE,
    protectedSkipped: protectedSkipped.slice(0, TRUNCATE),
    protectedSkippedTruncated: protectedSkipped.length > TRUNCATE,
    volumeBreakdown,
    outlierVolumes,
    noisyChapters: noisy,
  };
}
