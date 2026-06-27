import { getProvider, defaultDownloadProvider } from '../providers/index.js';
import { provider as mangaupdates, fetchChapterVolumeMap } from '../providers/mangaupdates.js';
import {
  createSeries, getSeries, updateSeries, touchSeriesScan,
  upsertChapter, chapterStateCounts,
} from './repo.js';
import { isProviderEnabled, getSetting } from './settings.js';
import { scanLibrary } from './library-scan.js';
import { resolveVolumes } from './mapping.js';
import { logHistory } from './db.js';

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

  // Volume-count hint (for estimated grouping) only applies to manga via MangaUpdates.
  let totalVolumesHint = null;
  if (mediaType === 'manga' && isProviderEnabled('mangaupdates')) {
    const mu = await mangaupdates.getTotalVolumesForTitle(details.title).catch(() => null);
    totalVolumesHint = mu?.totalVolumes ?? null;
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

  if (series.media_type === 'manga' && isProviderEnabled('mangaupdates')) {
    try {
      const mu = await mangaupdates.getTotalVolumesForTitle(series.title);
      if (mu?.totalVolumes && series.total_volumes_hint !== mu.totalVolumes) {
        updateSeries(seriesId, { totalVolumesHint: mu.totalVolumes });
      }
      if (mu?.latestChapter && mu.latestChapter > 0) {
        const knownNums = new Set(chapters.map(c => String(parseFloat(c.number))));
        for (let i = 1; i <= mu.latestChapter; i++) {
          if (!knownNums.has(String(i))) {
            chapters.push({
              id: `mu-synth-${seriesId}-${i}`,
              number: String(i),
              volume: null,
              title: `Chapter ${i}`,
              lang: series.language,
            });
          }
        }
      }

      // Backfill volume numbers that MangaDex left null using MangaUpdates' release
      // records.  Each release record carries the chapter number AND the volume it
      // belongs to, giving authoritative boundaries for series where the MangaDex
      // aggregate is sparse (e.g. Dandadan, One Piece English simulpubs).
      // We only fill chapters that currently lack a volume — never overwrite a
      // real provider-tagged assignment.
      const hasNullVol = chapters.some(c => !c.volume);
      if (hasNullVol && mu?.seriesId) {
        try {
          const muVolMap = await fetchChapterVolumeMap(mu.seriesId);
          if (muVolMap.size > 0) {
            for (const ch of chapters) {
              if (!ch.volume) {
                const v = muVolMap.get(String(parseFloat(ch.number)));
                if (v) ch.volume = v;
              }
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
  return { added, counts: chapterStateCounts(seriesId) };
}
