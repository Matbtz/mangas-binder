import { getProvider } from '../providers/index.js';
import { provider as mangaupdates } from '../providers/mangaupdates.js';
import {
  createSeries, getSeries, updateSeries, touchSeriesScan,
  upsertChapter, chapterStateCounts,
} from './repo.js';
import { isProviderEnabled, getSetting } from './settings.js';
import { logHistory } from './db.js';

/**
 * Follow a new series: fetch metadata from the source, optionally enrich the
 * total-volume hint from MangaUpdates, persist it, then run an initial refresh
 * to populate its chapter list.
 *
 * @param {string} providerName
 * @param {string} providerSeriesId
 * @param {{ monitorMode?, packagingMode?, language? }} opts
 */
export async function followSeries(providerName, providerSeriesId, opts = {}) {
  const provider = getProvider(providerName);
  if (!isProviderEnabled(providerName)) throw new Error(`Provider ${providerName} is disabled`);
  if (!provider.capabilities.download) throw new Error(`Provider ${providerName} cannot download`);

  const details = await provider.getSeries(providerSeriesId);

  let totalVolumesHint = null;
  if (isProviderEnabled('mangaupdates')) {
    const mu = await mangaupdates.getTotalVolumesForTitle(details.title).catch(() => null);
    totalVolumesHint = mu?.totalVolumes ?? null;
  }

  const series = createSeries({
    provider: providerName,
    providerSeriesId,
    title: details.title,
    authors: details.authors,
    artists: details.artists,
    genres: details.genres,
    description: details.description,
    year: details.year,
    status: details.status,
    language: opts.language || getSetting('defaultLanguage', 'en'),
    monitored: true,
    monitorMode: opts.monitorMode || getSetting('defaultMonitorMode', 'all'),
    packagingMode: opts.packagingMode || getSetting('defaultPackagingMode', 'volume'),
    totalVolumesHint,
  });

  logHistory('series.followed', { seriesId: series.id, message: details.title });
  await refreshSeries(series.id);
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

  const chapters = await provider.listChapters(series.provider_series_id, { lang: series.language });

  let added = 0;
  for (const ch of chapters) {
    const initialState = (noneMode || (futureOnly && firstScan)) ? 'skipped' : 'wanted';
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
  return { added, counts: chapterStateCounts(seriesId) };
}
