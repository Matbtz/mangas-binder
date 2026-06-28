import { chapterStateCounts } from '../core/repo.js';

/** Shape a series DB row for API responses (parse JSON columns, add counts). */
export function seriesView(row, { withCounts = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    providerSeriesId: row.provider_series_id,
    mediaType: row.media_type || 'manga',
    downloadProvider: row.download_provider || row.provider,
    publisher: row.publisher || null,
    title: row.title,
    authors: JSON.parse(row.authors_json || '[]'),
    artists: JSON.parse(row.artists_json || '[]'),
    genres: JSON.parse(row.genres_json || '[]'),
    description: row.description,
    year: row.year,
    status: row.status,
    coverPath: row.cover_path || null,
    folderPath: row.folder_path || null,
    language: row.language,
    monitored: !!row.monitored,
    monitorMode: row.monitor_mode,
    monitorFromVolume: row.monitor_from_volume ?? null,
    packagingMode: row.packaging_mode,
    totalVolumesHint: row.total_volumes_hint,
    lastScanAt: row.last_scan_at,
    externalLinks: row.externalLinks || (row.external_links_json ? JSON.parse(row.external_links_json) : {}),
    counts: withCounts ? chapterStateCounts(row.id) : undefined,
  };
}

/** Shape a chapter DB row for API responses. */
export function chapterView(row) {
  if (!row) return null;
  return {
    id: row.id,
    seriesId: row.series_id,
    number: row.number,
    volume: row.volume,
    title: row.title,
    language: row.language,
    state: row.state,
    pages: row.pages,
    calculated: !!row.calculated,
    attempts: row.attempts,
    error: row.error,
    cbzPath: row.cbz_path,
    downloadUrl: row.download_url || null,
    publishedAt: row.published_at,
    progDone: row.prog_done ?? null,
    progTotal: row.prog_total ?? null,
    startedAt: row.started_at ?? null,
  };
}
