import { getDb } from './src/core/db.js';
const db = getDb();
db.prepare("INSERT OR REPLACE INTO provider_stats (provider_name, chapters_ok, chapters_failed, quality_score, quality_samples, warnings_json, last_updated) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
  .run('mangadex', 1243, 12, 0.75, 1200, '[]');
db.prepare("INSERT OR REPLACE INTO provider_stats (provider_name, chapters_ok, chapters_failed, quality_score, quality_samples, warnings_json, last_updated) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
  .run('comicvine', 89, 23, 0.5, 110, JSON.stringify([{ts: new Date().toISOString(), message: "Failed fetching metadata for issue #23"}]));
db.prepare("INSERT OR REPLACE INTO provider_stats (provider_name, chapters_ok, chapters_failed, quality_score, quality_samples, warnings_json, last_updated) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
  .run('mangakatana', 34, 41, 0.25, 70, JSON.stringify([{ts: new Date().toISOString(), message: "Timeout during page download"}, {ts: new Date().toISOString(), message: "Cloudflare challenge failed"}]));
