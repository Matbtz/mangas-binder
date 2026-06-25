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
  provider           TEXT NOT NULL,
  provider_series_id TEXT NOT NULL,
  title              TEXT NOT NULL,
  sort_title         TEXT,
  authors_json       TEXT DEFAULT '[]',
  artists_json       TEXT DEFAULT '[]',
  description        TEXT DEFAULT '',
  genres_json        TEXT DEFAULT '[]',
  year               INTEGER,
  status             TEXT,
  cover_path         TEXT,
  language           TEXT NOT NULL DEFAULT 'en',
  monitored          INTEGER NOT NULL DEFAULT 1,
  monitor_mode       TEXT NOT NULL DEFAULT 'all',     -- all | future | none
  packaging_mode     TEXT NOT NULL DEFAULT 'volume',  -- volume | chapter
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
  calculated          INTEGER NOT NULL DEFAULT 0,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
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

export function getDb() {
  if (db) return db;
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
