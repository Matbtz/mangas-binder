# mangas-binder — Architecture Plan

> Goal: a lightweight, self-hosted **"Sonarr/Radarr for manga"** that follows series,
> downloads chapters from configurable sources, binds them into **CBZ volumes with
> ComicInfo.xml + cover**, and drops them into a **[Tome](https://github.com/bndct-devops/tome)**
> library for reading.
>
> Scope: single-user first, "minimal users" later. Less ambition than Sonarr — no
> torrent indexers, no quality profiles. Just: follow → download → bind → hand off to Tome.

---

## 0. Implementation status

Phases 0–5 are implemented (web UI + API + scheduler + download/bind pipeline +
Tome handoff). Two deviations from the stack proposed below, both simplifications:

- **DB:** uses Node's built-in `node:sqlite` (Node ≥ 22.5) instead of
  `better-sqlite3` — no native build step, zero extra deps.
- **Frontend:** a no-build vanilla-JS SPA (`web/`) instead of Vite+Preact — keeps
  the "less ambition" footprint; can be swapped later without touching the API.

Not yet done: notifications, import-existing-library, upgrade/dedupe beyond
skip-if-exists. End-to-end download couldn't be exercised in CI (MangaDex blocks
datacenter IPs); the offline pipeline (bind/volume-completeness/CBZ/ComicInfo) is
tested.

---

## 1. Prior art (does this already exist?)

| Project | What it is | Why we still build |
|---|---|---|
| **Suwayomi/Tachidesk** | Headless manga server w/ extension sources | Heavy (JVM); is its own reader, doesn't target Tome / volume-packaged CBZ |
| **Kapowarr** | "Sonarr for comics" → CBZ | Comics (ComicVine/GCD), not manga sources |
| **Mylar3** | Sonarr-like comic manager | Comics, indexer/torrent-oriented |
| **Mangal** | CLI manga → CBZ | No follow/auto-scan service, no library handoff |
| **Komga / Kavita** | Library servers/readers | Consume CBZ; don't download |

**Our niche:** manga-first acquisition that produces **Tome-ready, volume-packaged CBZs**
with rich ComicInfo metadata — the one thing none of the above does cleanly for Tome.

> ⚠️ **Legal/ToS note.** Bulk-downloading from aggregator APIs generally violates their
> terms (MangaDex's API terms forbid storing/redistributing and demand rate-limit respect).
> This tool is designed for **personal archival**, with polite per-source rate limiting and
> pluggable sources so the operator owns that choice.

---

## 2. Where we are today (existing code)

The current repo is a **one-shot CLI binder** — it assumes chapters are *already on disk*
and bundles them into CBZ volumes. It is ~70% of the hard domain logic for the new system.

| File | Role | Fate in new design |
|---|---|---|
| `src/mangadex.js` | MangaDex search / volume map / metadata / covers | **Refactor** into a `Provider` (add page download) |
| `src/mangaupdates.js` | Total-volume count | **Keep** as a metadata-only provider |
| `src/extrapolate.js` | Estimate volume boundaries for untagged chapters | **Keep verbatim** (core differentiator) |
| `src/packager.js` | Build + write CBZ (archiver) | **Keep**, tweak naming (Tome) |
| `src/comicinfo.js` | ComicInfo.xml v2.0 | **Keep** (already Tome-compatible) |
| `src/scanner.js` | Scan local chapter folders | **Keep** for *import-existing* |
| `src/index.js` | CLI wiring | **Becomes** a thin client over `core/` |

What's missing for the Sonarr vision: persistence, **actual image downloading**, a
**source on/off abstraction**, a **scheduler**, a **web UI/API**, and a **library handoff**.

---

## 3. Tome integration contract (the target)

Tome is **not modified**. We integrate purely through the filesystem + ComicInfo.xml.

### 3.1 Handoff
Tome exposes three mounts (env-configurable):

| Tome env | Default mount | Meaning |
|---|---|---|
| `TOME_LIBRARY_DIR` | `/books` | Final library (read-only is fine for Tome) |
| `TOME_INCOMING_DIR` | `/bindery` | **Bindery inbox** — drop files, review, accept |
| `TOME_DATA_DIR` | `/data` | Tome's own SQLite + cover cache |
| `TOME_AUTO_IMPORT` | `false` | Auto-ingest bindery every 300s |

**Recommended:** mangas-binder writes finished CBZs to a **shared volume** that Tome mounts
as its **Bindery** (`TOME_INCOMING_DIR`). Operator either reviews in Tome's Bindery UI, or
sets `TOME_AUTO_IMPORT=true` for hands-off ingest. (Writing straight into `/books` is also
supported via config for users who want to skip Bindery review.)

```
                 shared docker volume
mangas-binder  ───────────────────────►  Tome
 OUTPUT_DIR  ──writes CBZ──►  /bindery  ──Tome import──►  /books ──reader
```

### 3.2 File naming (match Tome's parser)
Tome reads **ComicInfo.xml first** for CBZ, and falls back to filename parsing. Its parser
recognizes `Series Vol. N`, `Series, Vol. N`, `Series Book N`, `NN. Title`. So:

| Mode | Path template (default, configurable) |
|---|---|
| Volume | `{series}/{series} Vol. {vol:02}.cbz` |
| Volume (estimated) | `{series}/{series} Vol. {vol:02}.cbz` *(ComicInfo `Notes` marks it calculated)* |
| Chapter | `{series}/{series} - Chapter {chapter:04}.cbz` *(ComicInfo `Number` = chapter)* |

> ⚠️ **Change from today:** packager currently emits `Series V01.cbz` → switch to
> `Series Vol. 01.cbz` so Tome's filename fallback also works.

### 3.3 ComicInfo.xml — already aligned
`comicinfo.js` emits the exact fields Tome reads: `Series`, `Number`, `Title`, `Summary`,
`Year`, `Writer`, `Penciller`, `Genre`, `LanguageISO`, **`<Manga>Yes</Manga>`** (triggers
Tome's RTL/manga mode), `Web`. Our MangaDex/MangaUpdates metadata is *richer for manga*
than Tome's own ebook sources (Hardcover/Google Books/OpenLibrary) — a real selling point.
Page order inside the archive stays zero-padded (`ch0012_p003.jpg`) so Tome's streaming
page delivery orders correctly.

---

## 4. Target architecture

Stay on **Node.js** (the valuable logic is here; Tome being Python is irrelevant — they
talk via the filesystem). One process, SQLite, optional SPA.

```
┌──────────────────────────────────────────────────────────────┐
│  Web UI (Vite + Preact SPA)  ──HTTP──►  REST API (Fastify)    │
└──────────────────────────────────────────────────────────────┘
                               │
      ┌────────────────────────┼───────────────────────────┐
      ▼                        ▼                            ▼
  Scheduler (node-cron)   Worker / Queue              SQLite (better-sqlite3)
  refresh every X h       state machine               series · chapters · queue
      │                        │                        settings · providers · history
      ▼                        ▼
 ┌────────────┐   ┌────────────┬───────────┬───────────────┐
 │ Providers  │──►│ Downloader │──►  Binder ──►  Tome Target │
 │ (sources)  │   │ pages→jpg  │   (CBZ)     │  (bindery/lib)│
 └────────────┘   └────────────┴───────────┴───────────────┘
  MangaDex(dl),     p-limit +        reuse packager +
  MangaUpdates(meta) retry/backoff   comicinfo + extrapolate
```

### 4.1 Provider abstraction ("which APIs we enable")
A registry of sources, each toggled in settings. Common interface:

```js
// providers/base.js
interface Provider {
  name: string
  capabilities: { download: boolean, metadata: boolean }
  search(title)                  -> [{ id, title, year, cover }]
  getSeries(id)                  -> { title, authors, artists, genres, description, year, status }
  listChapters(id, { lang })     -> [{ id, number, volume?, title, lang, publishedAt, pages? }]
  getChapterPages(chapterId)     -> [imageUrl, ...]
  getVolumeCovers(id)            -> Map<volume, coverUrl>
}
```

- **MangaDexProvider** — refactor of `mangadex.js`. Adds `getChapterPages` via the
  **MangaDex@Home** flow: `GET /at-home/server/{chapterId}` → `{ baseUrl, chapter:{ hash,
  data[], dataSaver[] } }`; page URL = `{baseUrl}/data/{hash}/{file}`. `capabilities.download = true`.
- **MangaUpdatesProvider** — `mangaupdates.js`, `capabilities = { metadata: true }` only
  (total-volume hint feeding `extrapolate.js`).
- New sources later just implement the interface + register; UI lists them with on/off.

### 4.2 Downloader
- `p-limit` concurrency (default 4), per-source **rate limiter** (extends existing 429
  retry), exponential backoff, correct `Referer`/User-Agent.
- Downloads a chapter's pages into `staging/{series}/{chapter}/` as `001.jpg…`.
- Resumable: skip already-present pages; verify count vs `pages`.
- (Polite) optional MangaDex@Home success/failure reporting.

### 4.3 Binder (reuse)
Wraps `packager.js` + `comicinfo.js` + `extrapolate.js`. Two packaging modes **per series**:

- **`chapter`** — bind each downloaded chapter immediately → one CBZ per chapter.
- **`volume`** — accumulate; when a volume is **complete** (per provider volume map, or
  `extrapolate.js` estimate for ongoing/untagged volumes), bind the whole volume, then
  optionally purge loose pages. Incomplete volumes wait.

Completeness check = "all chapter numbers the provider assigns to volume N are in
`imported`/`downloaded` state."

### 4.4 Tome Target (library handoff)
- Renders the path template (§3.2), writes CBZ atomically to a temp name then `rename`
  into `OUTPUT_DIR` (the bindery/library mount).
- **Dedupe**: skip if target exists; optional **upgrade** (replace a previously-bound
  partial/estimated volume once it's confirmed complete). Mirrors Tome's own SHA-256 dedupe.
- Marks chapters/volumes `imported` in our DB.

### 4.5 Scheduler + state machine
`node-cron` every `SCAN_INTERVAL_HOURS`:
1. For each **monitored** series → `provider.listChapters()`.
2. Diff against DB; insert new chapters as `wanted` (respecting `monitor_mode`:
   `all` / `future-only` / `none`).
3. Enqueue `wanted` → worker drains the queue.

Per-chapter lifecycle:
```
wanted → queued → downloading → downloaded → packaged → imported
                       └────────► failed ──(backoff, attempts<N)──► queued
                                  skipped (manual / unavailable)
```

---

## 5. Data model (SQLite, better-sqlite3)

```sql
series(
  id, provider, provider_series_id, title, sort_title,
  authors_json, artists_json, description, genres_json, year, status,
  cover_path, language,
  monitored BOOL, monitor_mode TEXT,        -- all | future | none
  packaging_mode TEXT,                       -- chapter | volume
  total_volumes_hint INT, created_at, updated_at,
  UNIQUE(provider, provider_series_id))

chapters(
  id, series_id FK, provider, provider_chapter_id,
  number TEXT, volume TEXT, title, language, published_at, pages INT,
  state TEXT,                                -- wanted|queued|downloading|downloaded|packaged|imported|failed|skipped
  staging_path, cbz_path, calculated BOOL, attempts INT, error, updated_at,
  UNIQUE(series_id, number, language))

queue(
  id, type TEXT, series_id, chapter_id, priority INT,
  state TEXT, scheduled_at, started_at, finished_at, attempts INT, last_error)

settings(key PRIMARY KEY, value_json)        -- output dir, interval, concurrency, naming template, default modes
providers(id, name, enabled BOOL, config_json)  -- base url, api keys, rate limits, lang
history(id, ts, series_id, chapter_id, event, message)
users(id, username, password_hash, role)     -- STUB: single-user now, grows to minimal multi-user
```

---

## 6. REST API (Fastify)

```
GET    /api/search?q=&provider=         -> provider search results
POST   /api/series                      -> follow {provider, providerSeriesId, monitorMode, packagingMode, language}
GET    /api/series                      -> list followed (+state summary)
GET    /api/series/:id                  -> detail + chapters/volumes + states
PATCH  /api/series/:id                  -> update monitor/packaging/language
DELETE /api/series/:id                  -> unfollow (keep files?)
POST   /api/series/:id/refresh          -> force provider re-scan
POST   /api/chapters/:id/(download|skip|retry)
GET    /api/queue   /  /api/history     -> activity / past
GET    /api/settings  PATCH /api/settings
GET    /api/providers  PATCH /api/providers/:name   -> enable/disable + config
POST   /api/import                      -> seed DB from existing folders (scanner.js)
GET    /api/health                      -> queue depth, last scan, failures
```
Auth: single **API key / Basic auth** now (env `AUTH_TOKEN`); `users` table lets it grow to
minimal multi-user without reshaping the schema. Solo deployments can disable auth.

---

## 7. Web UI (Vite + Preact SPA, served by Fastify)

Minimal, Sonarr-flavored:
- **Search & Add** — search a source, follow with monitor + packaging choice.
- **Library** — followed series, progress (have/total), per-series settings.
- **Activity** — live queue + history; retry/skip.
- **Settings** — Tome output dir, scan interval, concurrency, **enabled sources** (toggles),
  default packaging mode, language, naming template.
- **System/Health** — last scan, failures, version.

---

## 8. Proposed directory structure

```
src/
  providers/
    base.js            # interface + JSDoc
    index.js           # registry / enable-disable
    mangadex.js        # refactor of current + getChapterPages (at-home)
    mangaupdates.js    # metadata-only
  core/
    db.js              # better-sqlite3 + migrations
    settings.js
    binder.js          # wraps packager + comicinfo + completeness logic
    library.js         # Tome target: naming template, atomic move, dedupe/upgrade
    extrapolate.js     # (moved, unchanged)
    scanner.js         # (moved) import-existing
    packager.js        # (moved) naming tweak only
    comicinfo.js       # (moved, unchanged)
  download/
    downloader.js      # pages -> jpg, concurrency, retry, rate limit
    queue.js           # job queue + chapter state machine
  scheduler/
    scheduler.js       # node-cron refresh + enqueue
  server/
    app.js             # Fastify + static SPA
    routes/*.js
  cli/
    index.js           # existing CLI, re-pointed at core/ (one-off bind + import)
web/                   # Vite + Preact SPA
Dockerfile             # single image
docker-compose.yml     # mangas-binder + tome sharing the bindery volume
```

---

## 9. Configuration (env)

```
DB_PATH=/data/mangas-binder.db
OUTPUT_DIR=/bindery                 # = Tome's TOME_INCOMING_DIR (shared volume)
STAGING_DIR=/data/staging
SCAN_INTERVAL_HOURS=6
DOWNLOAD_CONCURRENCY=4
DEFAULT_PACKAGING_MODE=volume       # volume | chapter
DEFAULT_LANGUAGE=en
NAMING_VOLUME={series}/{series} Vol. {vol2}.cbz
NAMING_CHAPTER={series}/{series} - Chapter {ch4}.cbz
AUTH_TOKEN=                         # empty = no auth (solo)
```

### docker-compose sketch
```yaml
services:
  mangas-binder:
    build: .
    environment: [ OUTPUT_DIR=/bindery, DB_PATH=/data/mangas-binder.db ]
    volumes: [ "./mb-data:/data", "bindery:/bindery" ]
    ports: [ "8787:8787" ]
  tome:
    image: tome:latest
    environment: [ TOME_INCOMING_DIR=/bindery, TOME_AUTO_IMPORT=true ]
    volumes: [ "bindery:/bindery", "./books:/books", "./tome-data:/data" ]
    ports: [ "8080:8080" ]
volumes: { bindery: {} }
```

---

## 10. Phased roadmap

| Phase | Deliverable | Risk |
|---|---|---|
| **0. Refactor** | Move logic into `core/`, introduce `Provider` interface, wrap MangaDex. CLI still works. Naming → `Vol. N`. | Low |
| **1. Persistence** | SQLite schema + settings + providers registry. | Low |
| **2. Download** | `getChapterPages` (at-home) + downloader (concurrency/retry/rate-limit). | Med — core new capability |
| **3. Pipeline** | download → bind → **Tome target**; chapter + volume modes; completeness. | Med |
| **4. Automation** | cron scheduler + queue/state machine + monitoring. | Med — the "Sonarr" heart |
| **5. API** | Fastify REST + API-key auth + import-existing. | Low |
| **6. Web UI** | Preact SPA (search/library/activity/settings). | Med |
| **7. Polish** | Dockerfile + compose w/ Tome, notifications (Discord/webhook), health, upgrade/dedupe. | Low |

Each phase is independently shippable; the tool is usefully better after every one.

---

## 11. Feature additions beyond the original ask

- **Import existing library** (`scanner.js`) so we never re-download what you have.
- **Per-series language** preference (MangaDex `availableTranslatedLanguage`).
- **Notifications** on new volume (Discord/webhook); optional Tome rescan ping.
- **Upgrade/dedupe** — replace estimated/partial volumes once confirmed complete.
- **Resume partial downloads**; per-source politeness/rate limits.
- **Health dashboard** — queue depth, last scan, failures.
```
