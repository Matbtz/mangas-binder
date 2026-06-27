import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import path from 'path';
import { config } from './config.js';

/**
 * Single shared SQLite connection (node:sqlite, built into Node >=22.5).
 * WAL mode + foreign keys on. Schema is created idempotently on open.
 */
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,                   -- metadata source (mangadex | comicvine)
  provider_series_id TEXT NOT NULL,
  media_type         TEXT NOT NULL DEFAULT 'manga',   -- manga | comic
  download_provider  TEXT,                            -- file source (mangadex | getcomics); defaults to provider
  publisher          TEXT,                            -- comics: publisher (ComicVine)
  title              TEXT NOT NULL,
  sort_title         TEXT,
  authors_json       TEXT DEFAULT '[]',
  artists_json       TEXT DEFAULT '[]',
  description        TEXT DEFAULT '',
  genres_json        TEXT DEFAULT '[]',
  year               INTEGER,
  status             TEXT,
  cover_path         TEXT,
  folder_path        TEXT,
  language           TEXT NOT NULL DEFAULT 'en',
  monitored          INTEGER NOT NULL DEFAULT 1,
  monitor_mode       TEXT NOT NULL DEFAULT 'all',     -- all | future | none | from
  monitor_from_volume REAL,                           -- lowest volume to download (monitor_mode='from')
  packaging_mode     TEXT NOT NULL DEFAULT 'volume',  -- volume | chapter (per-issue for comics)
  total_volumes_hint INTEGER,
  last_scan_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_series_id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id           INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  provider_chapter_id TEXT,
  number              TEXT NOT NULL,
  volume              TEXT,
  title               TEXT DEFAULT '',
  language            TEXT NOT NULL DEFAULT 'en',
  published_at        TEXT,
  pages               INTEGER,
  state               TEXT NOT NULL DEFAULT 'wanted',  -- wanted|queued|downloading|downloaded|packaged|imported|failed|skipped
  staging_path        TEXT,
  cbz_path            TEXT,
  download_url        TEXT,
  calculated          INTEGER NOT NULL DEFAULT 0,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  prog_done           INTEGER,                         -- live download progress (pages fetched)
  prog_total          INTEGER,                         -- live download progress (total pages); null = indeterminate
  started_at          TEXT,                            -- when the current download attempt began
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, number, language)
);
CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(series_id);
CREATE INDEX IF NOT EXISTS idx_chapters_state  ON chapters(state);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  name        TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  series_id  INTEGER,
  chapter_id INTEGER,
  event      TEXT NOT NULL,
  message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts);
`;

/**
 * Add columns introduced after the initial schema to pre-existing databases.
 * SQLite ALTER TABLE ADD COLUMN is idempotent only if we check first, so we
 * compare against PRAGMA table_info. New installs already have them via SCHEMA.
 */
function migrate(database) {
  const cols = database.prepare('PRAGMA table_info(series)').all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) database.exec(`ALTER TABLE series ADD COLUMN ${ddl}`); };
  add('media_type', "media_type TEXT NOT NULL DEFAULT 'manga'");
  add('download_provider', 'download_provider TEXT');
  add('publisher', 'publisher TEXT');
  add('folder_path', 'folder_path TEXT');
  add('monitor_from_volume', 'monitor_from_volume REAL');
  const chCols = database.prepare('PRAGMA table_info(chapters)').all().map(c => c.name);
  const addCh = (name, ddl) => { if (!chCols.includes(name)) database.exec(`ALTER TABLE chapters ADD COLUMN ${ddl}`); };
  addCh('download_url', 'download_url TEXT');
  addCh('prog_done', 'prog_done INTEGER');
  addCh('prog_total', 'prog_total INTEGER');
  addCh('started_at', 'started_at TEXT');
}

export function getDb() {
  if (db) return db;
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  // WAL + tuned pragmas: node:sqlite is synchronous and single-connection, so
  // every query blocks the event loop — keeping writes cheap and never stalling
  // on a lock matters. busy_timeout absorbs the scheduler/worker writing while a
  // request reads; synchronous=NORMAL is safe under WAL and avoids an fsync per
  // commit; the memory pragmas keep temp B-trees/sorts off the (NAS-backed) disk.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA cache_size = -16000;'); // ~16 MB page cache
  db.exec('PRAGMA wal_autocheckpoint = 1000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

/** Append an audit/history row. Best-effort; never throws into the caller. */
export function logHistory(event, { seriesId = null, chapterId = null, message = '' } = {}) {
  try {
    getDb()
      .prepare('INSERT INTO history (series_id, chapter_id, event, message) VALUES (?, ?, ?, ?)')
      .run(seriesId, chapterId, event, message);
  } catch { /* ignore logging failures */ }
}
