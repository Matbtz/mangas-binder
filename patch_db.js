import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/core/db.js', 'utf8');

const schemaAdd = `
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, number, language)
);
CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(series_id);
CREATE INDEX IF NOT EXISTS idx_chapters_state  ON chapters(state);

CREATE TABLE IF NOT EXISTS provider_stats (
  provider_name   TEXT PRIMARY KEY,
  chapters_ok     INTEGER NOT NULL DEFAULT 0,
  chapters_failed INTEGER NOT NULL DEFAULT 0,
  quality_score   REAL NOT NULL DEFAULT -1,
  quality_samples INTEGER NOT NULL DEFAULT 0,
  warnings_json   TEXT NOT NULL DEFAULT '[]',
  last_updated    TEXT
);

CREATE TABLE IF NOT EXISTS settings (
`;

content = content.replace(/  updated_at         TEXT NOT NULL DEFAULT \(datetime\('now'\)\),\n  UNIQUE\(series_id, number, language\)\n\);\nCREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters\(series_id\);\nCREATE INDEX IF NOT EXISTS idx_chapters_state  ON chapters\(state\);\n\nCREATE TABLE IF NOT EXISTS settings \(/, schemaAdd.trim() + '\n');

const chapterSchemaReplace = `
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
  scan_quality        TEXT DEFAULT 'unknown',
  min_page_width      INTEGER,
`;
content = content.replace(/  pages               INTEGER,\n  state               TEXT NOT NULL DEFAULT 'wanted',  -- wanted\|queued\|downloading\|downloaded\|packaged\|imported\|failed\|skipped\n  staging_path        TEXT,\n  cbz_path            TEXT,\n  download_url        TEXT,\n  calculated          INTEGER NOT NULL DEFAULT 0,\n  attempts            INTEGER NOT NULL DEFAULT 0,\n  error               TEXT,\n  prog_done           INTEGER,                         -- live download progress \(pages fetched\)\n  prog_total          INTEGER,                         -- live download progress \(total pages\); null = indeterminate\n  started_at          TEXT,                            -- when the current download attempt began/g, chapterSchemaReplace.trim());

const migrateAdd = `
  addCh('prog_done', 'prog_done INTEGER');
  addCh('prog_total', 'prog_total INTEGER');
  addCh('started_at', 'started_at TEXT');
  addCh('scan_quality', "scan_quality TEXT DEFAULT 'unknown'");
  addCh('min_page_width', 'min_page_width INTEGER');
`;
content = content.replace(/  addCh\('prog_done', 'prog_done INTEGER'\);\n  addCh\('prog_total', 'prog_total INTEGER'\);\n  addCh\('started_at', 'started_at TEXT'\);/g, migrateAdd.trim());

writeFileSync('src/core/db.js', content);
