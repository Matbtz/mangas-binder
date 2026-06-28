import { getDb } from './db.js';
import { config } from './config.js';
import { allProviders } from '../providers/index.js';

/**
 * Key/value settings + per-provider enabled state, persisted in SQLite.
 * On first run, defaults from config are seeded and every known provider
 * is registered (enabled by default).
 */

function seedSetting(key, value) {
  getDb()
    .prepare('INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}

let seeded = false;
export function ensureSeeded() {
  if (seeded) return;
  const d = config.defaults;
  seedSetting('scanIntervalHours', d.scanIntervalHours);
  seedSetting('downloadConcurrency', d.downloadConcurrency);
  seedSetting('chapterConcurrency', d.chapterConcurrency);
  seedSetting('downloadsPaused', d.downloadsPaused);
  seedSetting('refreshConcurrency', d.refreshConcurrency);
  seedSetting('seriesRefreshTimeoutSec', d.seriesRefreshTimeoutSec);
  seedSetting('defaultPackagingMode', d.defaultPackagingMode);
  seedSetting('defaultMonitorMode', d.defaultMonitorMode);
  seedSetting('defaultLanguage', d.defaultLanguage);
  seedSetting('dataSaver', d.dataSaver);
  seedSetting('keepLoosePages', d.keepLoosePages);
  seedSetting('extrapolateVolumes', d.extrapolateVolumes);
  seedSetting('flaresolverrUrl', d.flaresolverrUrl);
  seedSetting('mangaFallbackEnabled', d.mangaFallbackEnabled);
  seedSetting('discordWebhook', d.discordWebhook);
  seedSetting('ntfyUrl', d.ntfyUrl);
  seedSetting('notifyOnBindery', d.notifyOnBindery);
  seedSetting('notifyOnImport', d.notifyOnImport);
  seedSetting('notifyOnError', d.notifyOnError);
  seedSetting('notifyOnScan', d.notifyOnScan);
  seedSetting('notifyOnNewChapter', d.notifyOnNewChapter);
  seedSetting('debugLogs', d.debugLogs);
  seedSetting('libraryScanDirs', config.libraryScanDirs.join(', '));
  seedSetting('stagingDir', config.stagingDir);
  seedSetting('outputDir', config.outputDir);

  // Most providers default to enabled; ToS-sensitive scrapers used only as a
  // fallback (MangaKatana) default to disabled so they're opt-in.
  const DISABLED_BY_DEFAULT = new Set(['mangakatana']);
  const ins = getDb().prepare('INSERT OR IGNORE INTO providers (name, enabled) VALUES (?, ?)');
  for (const p of allProviders()) ins.run(p.name, DISABLED_BY_DEFAULT.has(p.name) ? 0 : 1);

  // Seed provider config from env on first run (Docker convenience). Existing
  // values set in the UI are never overwritten.
  if (process.env.COMICVINE_API_KEY) {
    const cur = getProviderConfig('comicvine');
    if (cur.apikey !== process.env.COMICVINE_API_KEY) setProviderConfig('comicvine', { ...cur, apikey: process.env.COMICVINE_API_KEY });
  }
  if (process.env.GETCOMICS_BASE_URL) {
    const cur = getProviderConfig('getcomics');
    if (cur.baseUrl !== process.env.GETCOMICS_BASE_URL) setProviderConfig('getcomics', { ...cur, baseUrl: process.env.GETCOMICS_BASE_URL });
  }
  if (process.env.HARDCOVER_API_KEY) {
    const cur = getProviderConfig('hardcover');
    if (cur.apikey !== process.env.HARDCOVER_API_KEY) setProviderConfig('hardcover', { ...cur, apikey: process.env.HARDCOVER_API_KEY });
  }
  seeded = true;
}

export function getSetting(key, fallback = undefined) {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

export function setSetting(key, value) {
  getDb()
    .prepare(`INSERT INTO settings (key, value_json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
    .run(key, JSON.stringify(value));
  return value;
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value_json FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.value_json);
  return out;
}

// --- Providers -------------------------------------------------------------

export function getProviderStates() {
  return getDb().prepare('SELECT name, enabled, config_json FROM providers').all()
    .map(r => ({ name: r.name, enabled: !!r.enabled, config: JSON.parse(r.config_json) }));
}

export function isProviderEnabled(name) {
  const row = getDb().prepare('SELECT enabled FROM providers WHERE name = ?').get(name);
  return row ? !!row.enabled : false;
}

/** A provider's persisted config object (e.g. ComicVine api key). */
export function getProviderConfig(name) {
  const row = getDb().prepare('SELECT config_json FROM providers WHERE name = ?').get(name);
  return row ? JSON.parse(row.config_json) : {};
}

export function setProviderEnabled(name, enabled) {
  getDb().prepare('UPDATE providers SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

export function setProviderConfig(name, configObj) {
  getDb().prepare('UPDATE providers SET config_json = ? WHERE name = ?')
    .run(JSON.stringify(configObj || {}), name);
}
