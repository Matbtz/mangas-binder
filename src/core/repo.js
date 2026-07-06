import { getDb } from './db.js';
import { publish } from './events.js';

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
       description, genres_json, year, status, cover_path, folder_path, language,
       monitored, monitor_mode, monitor_from_volume, packaging_mode, total_volumes_hint, total_chapters_hint, external_links_json)
    VALUES
      (@provider, @provider_series_id, @media_type, @download_provider, @publisher,
       @title, @sort_title, @authors_json, @artists_json,
       @description, @genres_json, @year, @status, @cover_path, @folder_path, @language,
       @monitored, @monitor_mode, @monitor_from_volume, @packaging_mode, @total_volumes_hint, @total_chapters_hint, @external_links_json)
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
    folder_path: s.folderPath ?? null,
    language: s.language ?? 'en',
    monitored: s.monitored ? 1 : 0,
    monitor_mode: s.monitorMode ?? 'all',
    monitor_from_volume: s.monitorFromVolume != null ? parseFloat(s.monitorFromVolume) : null,
    packaging_mode: s.packagingMode ?? 'volume',
    total_volumes_hint: s.totalVolumesHint ?? null,
    total_chapters_hint: s.totalChaptersHint ?? null,
    external_links_json: s.externalLinks != null ? JSON.stringify(s.externalLinks) : null,
  });
  return getSeriesByProvider(s.provider, s.providerSeriesId);
}

export function getSeries(id) {
  const s = getDb().prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (s && s.external_links_json) s.externalLinks = JSON.parse(s.external_links_json);
  return s;
}

export function getSeriesByProvider(provider, providerSeriesId) {
  const s = getDb().prepare('SELECT * FROM series WHERE provider = ? AND provider_series_id = ?').get(provider, providerSeriesId);
  if (s && s.external_links_json) s.externalLinks = JSON.parse(s.external_links_json);
  return s;
}

export function listSeries() {
  const rows = getDb().prepare('SELECT * FROM series ORDER BY sort_title COLLATE NOCASE').all();
  for (const s of rows) {
    if (s.external_links_json) s.externalLinks = JSON.parse(s.external_links_json);
  }
  return rows;
}

export function listMonitoredSeries() {
  return getDb().prepare("SELECT * FROM series WHERE monitored = 1 AND monitor_mode != 'none'").all();
}

const SERIES_PATCH_COLS = {
  monitored: v => (v ? 1 : 0),
  monitorMode: v => v,
  monitorFromVolume: v => (v == null ? null : parseFloat(v)),
  packagingMode: v => v,
  language: v => v,
  totalVolumesHint: v => v,
  totalChaptersHint: v => v,
  lastScanAt: v => v,
  // Cached external (non-MangaDex) per-chapter volume map (see
  // core/chapter-map-consensus.js). Stored as an opaque JSON blob — null clears
  // it (used by the series "reset" route to force a fresh fetch next refresh).
  chapterMapCache: v => (v == null ? null : JSON.stringify(v)),
  coverPath: v => v,
  folderPath: v => v,
  provider: v => v,
  providerSeriesId: v => v,
  downloadProvider: v => v,
  mediaType: v => v,
  title: v => v,
  description: v => v,
  externalLinks: v => JSON.stringify(v),
};
const SERIES_COL_NAMES = {
  monitored: 'monitored', monitorMode: 'monitor_mode', monitorFromVolume: 'monitor_from_volume',
  packagingMode: 'packaging_mode',
  language: 'language', totalVolumesHint: 'total_volumes_hint', totalChaptersHint: 'total_chapters_hint',
  lastScanAt: 'last_scan_at',
  chapterMapCache: 'chapter_map_cache_json',
  coverPath: 'cover_path', folderPath: 'folder_path',
  provider: 'provider', providerSeriesId: 'provider_series_id',
  downloadProvider: 'download_provider', mediaType: 'media_type', title: 'title',
  description: 'description',
  externalLinks: 'external_links_json',
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

/**
 * Delete every chapter row of a series (leaving the series itself and any
 * on-disk files intact). Used by the "reset series" action so a subsequent
 * refresh rebuilds the chapter list from scratch — the way to clear stale or
 * mis-estimated volume data accumulated by earlier scans. Returns the count
 * of rows removed.
 */
export function deleteChaptersForSeries(id) {
  const info = getDb().prepare('DELETE FROM chapters WHERE series_id = ?').run(id);
  return Number(info.changes || 0);
}

/**
 * Prune stale gap-fill placeholder chapters whose number is beyond the series'
 * current known latest chapter. Gap-fill synthesises chapters `1..latestChapter`
 * (marked with a `synth-` provider_chapter_id) on every refresh, but a run where
 * the consensus latest-chapter was once too high leaves orphans behind that no
 * later run ever removes — a finished 55-chapter series ("Pet") was observed
 * holding 135 chapters, inflating every estimated volume's size. Only rows that
 * are (a) still purely synthetic (never seen from a real provider — a real
 * provider id overwrites the `synth-` one via COALESCE on upsert), (b) never
 * downloaded or attempted, and (c) numbered past `maxChapterNumber` are removed,
 * so nothing real or in-progress is ever touched. In-range placeholders are left
 * alone (the next gap-fill recreates them anyway). Returns rows removed.
 */
export function pruneSyntheticChaptersBeyond(seriesId, maxChapterNumber) {
  if (!(maxChapterNumber > 0)) return 0;
  const info = getDb().prepare(
    `DELETE FROM chapters
       WHERE series_id = ?
         AND provider_chapter_id LIKE 'synth-%'
         AND state IN ('wanted', 'skipped')
         AND attempts = 0
         AND CAST(number AS REAL) > ?`
  ).run(seriesId, maxChapterNumber);
  return Number(info.changes || 0);
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
    'SELECT id, language, calculated, volume FROM chapters WHERE series_id = ? AND number = ?'
  ).all(seriesId, number);

  if (existing.length > 0) {
    const main = existing[0];
    if (existing.length > 1) {
      const dupIds = existing.slice(1).map(e => e.id);
      db.prepare(`DELETE FROM chapters WHERE id IN (${dupIds.map(() => '?').join(',')})`).run(...dupIds);
    }

    // If a user manually defined a volume (calculated=0 and volume is set), we don't let the provider overwrite it.
    const isManuallyDefined = main.calculated === 0 && main.volume !== null && main.volume !== '';
    const nextVolume = isManuallyDefined ? null : (c.volume ?? null);

    // When the provider now supplies a real volume, record it as authoritative
    // (clear the `calculated` estimate flag) so a later resolveVolumes() keeps it
    // as an anchor instead of re-extrapolating it away. A null provider volume
    // leaves the existing flag untouched.
    if (main.language !== lang) {
      // Language upgrade/change: reset download state so the new language version is grabbed
      db.prepare(`UPDATE chapters SET
          volume = COALESCE(?, volume),
          calculated = CASE WHEN ? IS NOT NULL THEN 0 ELSE calculated END,
          provider_chapter_id = COALESCE(?, provider_chapter_id),
          pages = COALESCE(?, pages),
          title = COALESCE(?, title),
          language = ?,
          state = ?,
          error = NULL,
          attempts = 0,
          cbz_path = NULL,
          staging_path = NULL,
          updated_at = datetime('now')
        WHERE id = ?`)
        .run(nextVolume, nextVolume, c.providerChapterId ?? null, c.pages ?? null, c.title ?? null, lang, initialState, main.id);
      return false;
    } else {
      // Normal update
      db.prepare(`UPDATE chapters SET
          volume = COALESCE(?, volume),
          calculated = CASE WHEN ? IS NOT NULL THEN 0 ELSE calculated END,
          provider_chapter_id = COALESCE(?, provider_chapter_id),
          pages = COALESCE(?, pages),
          title = COALESCE(?, title),
          updated_at = datetime('now')
        WHERE id = ?`)
        .run(nextVolume, nextVolume, c.providerChapterId ?? null, c.pages ?? null, c.title ?? null, main.id);
      return false;
    }
  }

  db.prepare(`INSERT INTO chapters
      (series_id, provider, provider_chapter_id, number, volume, title, language, published_at, pages, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(seriesId, c.provider, c.providerChapterId ?? null, number, c.volume ?? null,
         c.title ?? '', lang, c.publishedAt ?? null, c.pages ?? null, initialState);

  if (initialState === 'wanted') {
    const s = db.prepare('SELECT title FROM series WHERE id = ?').get(seriesId);
    if (s) {
      import('./notify.js').then(m => m.notifyNewChapter(s.title, number));
    }
  }

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

/**
 * Slim per-chapter fields the live "tick" on the series detail page needs to
 * patch status cells, action buttons and volume badges — nothing else. The full
 * `listChaptersForSeries` + `chapterView` payload (title, language, pages,
 * quality, timestamps, …) was refetched and re-serialised for every chapter on
 * every SSE progress event; on a 1000+ chapter series that is a lot of wasted
 * DB read, JSON and client parse several times a second during downloads.
 */
export function listChapterProgress(seriesId) {
  return getDb().prepare(
    'SELECT id, number, state, volume, prog_done, prog_total, error, cbz_path FROM chapters WHERE series_id = ? ORDER BY CAST(number AS REAL)'
  ).all(seriesId).map(r => ({
    id: r.id,
    number: r.number,
    state: r.state,
    volume: r.volume,
    progDone: r.prog_done ?? null,
    progTotal: r.prog_total ?? null,
    error: r.error,
    cbzPath: r.cbz_path,
  }));
}

export function chaptersInState(state, limit = 100) {
  return getDb().prepare(
    `SELECT c.* FROM chapters c
     JOIN series s ON c.series_id = s.id
     WHERE c.state = ? AND s.monitored = 1 AND s.monitor_mode != 'none'
     ORDER BY c.id LIMIT ?`
  ).all(state, limit);
}

/** Chapters ready for the download worker: `wanted` + legacy `queued` state. */
export function chaptersReadyToDownload(limit = 100) {
  return getDb().prepare(
    `SELECT c.* FROM chapters c
     JOIN series s ON c.series_id = s.id
     WHERE c.state IN ('wanted', 'queued') AND s.monitored = 1 AND s.monitor_mode != 'none'
     ORDER BY c.id LIMIT ?`
  ).all(limit);
}

/** Chapters in any of the given states (optionally scoped to one series). */
export function listChaptersInStates(states, { seriesId = null, limit = 100000 } = {}) {
  if (!states.length) return [];
  const placeholders = states.map(() => '?').join(',');
  const where = seriesId == null ? '' : ' AND series_id = ?';
  const args = seriesId == null ? [...states, limit] : [...states, seriesId, limit];
  return getDb().prepare(
    `SELECT * FROM chapters WHERE state IN (${placeholders})${where} ORDER BY id LIMIT ?`
  ).all(...args);
}

export function setChapterState(id, state, extra = {}) {
  const db = getDb();
  const ch = db.prepare('SELECT state, number, series_id FROM chapters WHERE id = ?').get(id);
  const oldState = ch?.state;

  const cols = ['state = ?'];
  const vals = [state];
  for (const [k, col] of Object.entries({
    staging_path: 'staging_path', cbz_path: 'cbz_path', error: 'error',
    volume: 'volume', pages: 'pages', calculated: 'calculated', download_url: 'download_url',
    language: 'language', prog_done: 'prog_done', prog_total: 'prog_total', started_at: 'started_at',
    attempts: 'attempts',
  })) {
    if (extra[k] !== undefined) { cols.push(`${col} = ?`); vals.push(extra[k]); }
  }
  cols.push("updated_at = datetime('now')");
  db.prepare(`UPDATE chapters SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  publish('chapter', { id, state });

  if (ch && oldState !== state) {
    const s = db.prepare('SELECT title FROM series WHERE id = ?').get(ch.series_id);
    const seriesTitle = s ? s.title : `Series #${ch.series_id}`;
    if (state === 'imported') {
      import('./notify.js').then(m => m.notifyImport(seriesTitle, `Chapter ${ch.number}`));
    }
  }
}

export function setChapterQuality(id, scanQuality, minPageWidth) {
  getDb().prepare(
    "UPDATE chapters SET scan_quality = ?, min_page_width = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(scanQuality, minPageWidth, id);
}

/** Light progress write during a download — does not touch state. */

export function setChapterProgress(id, done, total) {
  getDb().prepare(
    "UPDATE chapters SET prog_done = ?, prog_total = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(done ?? null, total ?? null, id);
  publish('progress', { id, done, total });
}

export function bumpChapterAttempt(id) {
  getDb().prepare('UPDATE chapters SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function bulkSetChapterState(ids, state, { resetAttempts = false } = {}) {
  if (!ids.length) return 0;
  const db = getDb();
  const attemptsClause = resetAttempts ? ', attempts = 0' : '';
  const stmt = db.prepare(
    `UPDATE chapters SET state = ?, error = NULL${attemptsClause}, updated_at = datetime('now') WHERE id = ?`
  );
  // node:sqlite (DatabaseSync) has no .transaction() helper; wrap manually.
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(state, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  publish('chapters', { count: ids.length, state });
  return ids.length;
}

/**
 * Reset chapters left in a transient `downloading` state by a crash/restart back
 * to `wanted` so the worker resumes them (their in-flight controller is gone).
 * Run once at startup. Returns the number of rows reset.
 */
export function resetStaleDownloads() {
  // Reset attempts too: stale chapters were aborted by a crash, not a real failure,
  // so they shouldn't burn through their retry budget.
  const res = getDb().prepare(
    "UPDATE chapters SET state = 'wanted', attempts = 0, prog_done = NULL, prog_total = NULL, started_at = NULL, updated_at = datetime('now') WHERE state = 'downloading'"
  ).run();
  if (res.changes) publish('chapters', { count: res.changes, state: 'wanted' });
  return res.changes;
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

/** Chapters that have a cbz_path set, optionally scoped to a specific volume. */
export function listChapterFilesForSeries(seriesId, { volume } = {}) {
  if (volume === undefined) {
    return getDb().prepare(
      "SELECT * FROM chapters WHERE series_id = ? AND cbz_path IS NOT NULL AND cbz_path != '' ORDER BY CAST(number AS REAL)"
    ).all(seriesId);
  }
  if (volume === null) {
    return getDb().prepare(
      "SELECT * FROM chapters WHERE series_id = ? AND cbz_path IS NOT NULL AND cbz_path != '' AND volume IS NULL ORDER BY CAST(number AS REAL)"
    ).all(seriesId);
  }
  return getDb().prepare(
    "SELECT * FROM chapters WHERE series_id = ? AND cbz_path IS NOT NULL AND cbz_path != '' AND volume = ? ORDER BY CAST(number AS REAL)"
  ).all(seriesId, String(volume));
}
