import { getDb } from './db.js';

/**
 * Thin data-access helpers over the series/chapters tables. Rows are returned
 * as-is from SQLite; JSON columns are parsed by the *View helpers used by the API.
 */

// --- Series ----------------------------------------------------------------

export function createSeries(s) {
  getDb().prepare(`
    INSERT INTO series
      (provider, provider_series_id, media_type, download_provider, publisher,
       title, sort_title, authors_json, artists_json,
       description, genres_json, year, status, cover_path, language,
       monitored, monitor_mode, packaging_mode, total_volumes_hint)
    VALUES
      (@provider, @provider_series_id, @media_type, @download_provider, @publisher,
       @title, @sort_title, @authors_json, @artists_json,
       @description, @genres_json, @year, @status, @cover_path, @language,
       @monitored, @monitor_mode, @packaging_mode, @total_volumes_hint)
    ON CONFLICT(provider, provider_series_id) DO UPDATE SET
       title = excluded.title, updated_at = datetime('now')
  `).run({
    provider: s.provider,
    provider_series_id: s.providerSeriesId,
    media_type: s.mediaType ?? 'manga',
    download_provider: s.downloadProvider ?? s.provider,
    publisher: s.publisher ?? null,
    title: s.title,
    sort_title: s.sortTitle ?? s.title,
    authors_json: JSON.stringify(s.authors ?? []),
    artists_json: JSON.stringify(s.artists ?? []),
    description: s.description ?? '',
    genres_json: JSON.stringify(s.genres ?? []),
    year: s.year ?? null,
    status: s.status ?? null,
    cover_path: s.coverPath ?? null,
    language: s.language ?? 'en',
    monitored: s.monitored ? 1 : 0,
    monitor_mode: s.monitorMode ?? 'all',
    packaging_mode: s.packagingMode ?? 'volume',
    total_volumes_hint: s.totalVolumesHint ?? null,
  });
  return getSeriesByProvider(s.provider, s.providerSeriesId);
}

export function getSeries(id) {
  return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id);
}

export function getSeriesByProvider(provider, providerSeriesId) {
  return getDb().prepare('SELECT * FROM series WHERE provider = ? AND provider_series_id = ?')
    .get(provider, providerSeriesId);
}

export function listSeries() {
  return getDb().prepare('SELECT * FROM series ORDER BY sort_title COLLATE NOCASE').all();
}

export function listMonitoredSeries() {
  return getDb().prepare("SELECT * FROM series WHERE monitored = 1 AND monitor_mode != 'none'").all();
}

const SERIES_PATCH_COLS = {
  monitored: v => (v ? 1 : 0),
  monitorMode: v => v,
  packagingMode: v => v,
  language: v => v,
  totalVolumesHint: v => v,
};
const SERIES_COL_NAMES = {
  monitored: 'monitored', monitorMode: 'monitor_mode', packagingMode: 'packaging_mode',
  language: 'language', totalVolumesHint: 'total_volumes_hint',
};

export function updateSeries(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, transform] of Object.entries(SERIES_PATCH_COLS)) {
    if (patch[k] !== undefined) { sets.push(`${SERIES_COL_NAMES[k]} = ?`); vals.push(transform(patch[k])); }
  }
  if (!sets.length) return getSeries(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE series SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getSeries(id);
}

export function touchSeriesScan(id) {
  getDb().prepare("UPDATE series SET last_scan_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteSeries(id) {
  getDb().prepare('DELETE FROM series WHERE id = ?').run(id);
}

// --- Chapters --------------------------------------------------------------

/**
 * Insert a chapter if (series, number, language) is new, else refresh its
 * volume/pages/provider id. Returns true only when a NEW row was created
 * (so the scheduler can tell genuinely-new chapters from re-scans).
 */
export function upsertChapter(seriesId, c, initialState = 'wanted') {
  const db = getDb();
  const lang = c.language ?? 'en';
  const number = String(c.number);
  const existing = db.prepare(
    'SELECT id FROM chapters WHERE series_id = ? AND number = ? AND language = ?'
  ).get(seriesId, number, lang);

  if (existing) {
    db.prepare(`UPDATE chapters SET
        volume = COALESCE(?, volume),
        provider_chapter_id = COALESCE(?, provider_chapter_id),
        pages = COALESCE(?, pages),
        updated_at = datetime('now')
      WHERE id = ?`)
      .run(c.volume ?? null, c.providerChapterId ?? null, c.pages ?? null, existing.id);
    return false;
  }

  db.prepare(`INSERT INTO chapters
      (series_id, provider, provider_chapter_id, number, volume, title, language, published_at, pages, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(seriesId, c.provider, c.providerChapterId ?? null, number, c.volume ?? null,
         c.title ?? '', lang, c.publishedAt ?? null, c.pages ?? null, initialState);
  return true;
}

export function getChapter(id) {
  return getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id);
}

export function listChaptersForSeries(seriesId) {
  return getDb().prepare(
    'SELECT * FROM chapters WHERE series_id = ? ORDER BY CAST(number AS REAL)'
  ).all(seriesId);
}

export function chaptersInState(state, limit = 100) {
  return getDb().prepare(
    'SELECT * FROM chapters WHERE state = ? ORDER BY id LIMIT ?'
  ).all(state, limit);
}

export function setChapterState(id, state, extra = {}) {
  const cols = ['state = ?'];
  const vals = [state];
  for (const [k, col] of Object.entries({
    staging_path: 'staging_path', cbz_path: 'cbz_path', error: 'error',
    volume: 'volume', pages: 'pages', calculated: 'calculated',
  })) {
    if (extra[k] !== undefined) { cols.push(`${col} = ?`); vals.push(extra[k]); }
  }
  cols.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE chapters SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function bumpChapterAttempt(id) {
  getDb().prepare('UPDATE chapters SET attempts = attempts + 1 WHERE id = ?').run(id);
}

/** Per-series counts grouped by state, for the API summary. */
export function chapterStateCounts(seriesId) {
  const rows = getDb().prepare(
    'SELECT state, COUNT(*) n FROM chapters WHERE series_id = ? GROUP BY state'
  ).all(seriesId);
  const out = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export function recentHistory(limit = 100) {
  return getDb().prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?').all(limit);
}
