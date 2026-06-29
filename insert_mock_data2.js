import { getDb } from './src/core/db.js';
const db = getDb();
db.prepare("INSERT OR REPLACE INTO series (id, provider, provider_series_id, title, status) VALUES (1, 'mangadex', '123', 'My Manga', 'ongoing')").run();
db.prepare("INSERT OR REPLACE INTO chapters (id, series_id, provider, number, volume, state, scan_quality, min_page_width) VALUES (1, 1, 'mangadex', '1', '1', 'imported', 'high', 1440)").run();
db.prepare("INSERT OR REPLACE INTO chapters (id, series_id, provider, number, volume, state, scan_quality, min_page_width) VALUES (2, 1, 'mangadex', '2', '1', 'imported', 'ok', 1100)").run();
db.prepare("INSERT OR REPLACE INTO chapters (id, series_id, provider, number, volume, state, scan_quality, min_page_width) VALUES (3, 1, 'mangadex', '3', '2', 'imported', 'low', 750)").run();
db.prepare("INSERT OR REPLACE INTO chapters (id, series_id, provider, number, volume, state, scan_quality, min_page_width) VALUES (4, 1, 'mangadex', '4', '2', 'wanted', 'unknown', NULL)").run();
