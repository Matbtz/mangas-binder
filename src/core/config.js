import path from 'path';

/** Resolve a path, defaulting relative to the project data dir. */
function abs(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Static, process-level configuration from environment variables.
 * Mutable, per-series and operational preferences live in the DB (settings table);
 * this file is only for things needed before the DB is open (paths, ports, auth).
 */
export const config = {
  // Where Tome's Bindery / library is mounted — finished CBZs land here.
  outputDir: abs(process.env.OUTPUT_DIR || './data/output'),
  // Working area for in-progress page downloads (never exposed to Tome).
  stagingDir: abs(process.env.STAGING_DIR || './data/staging'),
  // SQLite database file.
  dbPath: abs(process.env.DB_PATH || './data/mangas-binder.db'),

  // Directories scanned to detect already-owned CBZs (defaults to outputDir).
  // Point an extra entry at Tome's library mount (e.g. /books, read-only) if Tome
  // moves files out of the Bindery on import. Comma-separated.
  libraryScanDirs: (process.env.LIBRARY_SCAN_DIRS
    ? process.env.LIBRARY_SCAN_DIRS.split(',')
    : [process.env.OUTPUT_DIR || './data/output']
  ).map(p => abs(p.trim())),

  // HTTP server.
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  // Empty token => no auth (fine for solo localhost). Set to require Bearer/?token=.
  authToken: process.env.AUTH_TOKEN || '',

  // Largest single uploaded file (CBZ/ZIP, or one loose page image) accepted by
  // POST /series/:id/upload-chapter, in MB. CBZs can run 100-300MB+.
  uploadMaxFileMB: Number(process.env.UPLOAD_MAX_FILE_MB || 500),

  // Defaults seeded into the settings table on first run.
  defaults: {
    scanIntervalHours: Number(process.env.SCAN_INTERVAL_HOURS || 6),
    downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY || 4), // parallel page fetches per chapter
    chapterConcurrency: Number(process.env.CHAPTER_CONCURRENCY || 2),   // chapters downloaded in parallel
    // Master kill-switch: when true, the worker never downloads or packages.
    // Handy when deploying/testing so the app doesn't start pulling files.
    downloadsPaused: process.env.DOWNLOADS_PAUSED === 'true',
    // Scheduler refresh: how many monitored series refresh in parallel, and how
    // long a single series' refresh may run before it's abandoned (so one stuck
    // source can't stall the whole scan cycle).
    refreshConcurrency: Number(process.env.REFRESH_CONCURRENCY || 3),
    seriesRefreshTimeoutSec: Number(process.env.SERIES_REFRESH_TIMEOUT_SEC || 90),
    // How long a resolved external (Wikipedia/Fandom/MangaUpdates) per-chapter
    // volume map stays cached on the series row before a refresh re-fetches it
    // (see core/chapter-map-consensus.js). A preview always may reuse a fresh
    // cache too, but never writes it.
    chapterMapCacheHours: Number(process.env.CHAPTER_MAP_CACHE_HOURS || 24),
    defaultPackagingMode: process.env.DEFAULT_PACKAGING_MODE || 'volume', // volume | chapter
    defaultMonitorMode: process.env.DEFAULT_MONITOR_MODE || 'all',         // all | future | none
    defaultLanguage: process.env.DEFAULT_LANGUAGE || 'en',
    dataSaver: process.env.DATA_SAVER === 'true',
    keepLoosePages: process.env.KEEP_LOOSE_PAGES === 'true',
    // Assign untagged chapters to estimated volumes (uses extrapolate.js).
    extrapolateVolumes: process.env.EXTRAPOLATE_VOLUMES !== 'false',
    // FlareSolverr endpoint (Cloudflare/anti-bot solver) for scraping providers
    // like MangaKatana. Empty = disabled. In Docker, point at the container on a
    // shared network, e.g. http://flaresolverr:8191/v1
    flaresolverrUrl: process.env.FLARESOLVERR_URL || '',
    // When true (and MangaKatana is enabled), failed MangaDex page downloads fall
    // back to scraping MangaKatana for the same chapter.
    mangaFallbackEnabled: process.env.MANGA_FALLBACK_ENABLED === 'true',
    // Notifications (empty = disabled). ntfyUrl is a full topic URL, e.g. https://ntfy.sh/my-topic
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    ntfyUrl: process.env.NTFY_URL || '',
    notifyOnBindery: process.env.NOTIFY_ON_BINDERY !== 'false',
    notifyOnImport: process.env.NOTIFY_ON_IMPORT === 'true',
    notifyOnError: process.env.NOTIFY_ON_ERROR === 'true',
    notifyOnScan: process.env.NOTIFY_ON_SCAN === 'true',
    notifyOnNewChapter: process.env.NOTIFY_ON_NEW_CHAPTER === 'true',
    debugLogs: process.env.DEBUG_LOGS === 'true',
    // Image preprocessing (KCC-style page treatment before packaging). Master
    // switch is off by default so output is unchanged until a profile is set up.
    imageProcessingEnabled: process.env.IMAGE_PROCESSING_ENABLED === 'true',
    // Which image profile (by id) applies to each media type. null = no treatment.
    imageProfileAssignments: { manga: null, comic: null },
  },
};
