# mangas-binder

A lightweight, self-hosted **"Sonarr/Radarr for manga *and* comics"**. Follow
series, download chapters/issues from configurable sources, bind them into **CBZ
files with ComicInfo.xml + cover**, and hand them off to a
**[Tome](https://github.com/bndct-devops/tome)** (or Komga/Kavita) library for reading.

mangas-binder is the *acquisition + binding* half (the "Sonarr"); the reader is
the *library* half. They talk through a shared folder — mangas-binder drops
reader-ready CBZs into the library's inbox.

| Media | Metadata | Files | Unit → package |
|-------|----------|-------|----------------|
| **Manga** | MangaDex (+ MangaUpdates hint) | MangaDex pages (MangaKatana fallback) | chapter → volume |
| **Comics** | ComicVine | GetComics (DDL) | issue → collected volume |

Comics work like manga with two differences: metadata comes from **ComicVine** and
files from **GetComics** (the same source [Kapowarr](https://github.com/Casvt/Kapowarr)
uses), and the unit is an **issue** packaged into a **collected volume** (rather
than a chapter into a tankōbon). Comics default to **one CBZ per issue**.

> ⚠️ **Personal archival tool.** Bulk-downloading from aggregator APIs/sites
> generally violates their terms of service. mangas-binder rate-limits politely and
> keeps sources pluggable so you own that choice. Use responsibly.

## Features

- 🔎 **Follow series** — manga from MangaDex, comics from ComicVine — via a web UI.
- ⚙️ **Enable/disable sources** — pluggable provider interface (metadata vs. files).
- ⬇️ **Downloader** fetches MangaDex page images *or* whole GetComics archives, with
  concurrency, retry/backoff, resume. Comic archives are unpacked into the same
  staging layout so the rest of the pipeline is shared.
- 📦 **Binds to CBZ** with embedded `ComicInfo.xml` (Series, Number, Volume,
  Publisher, authors, genres, summary; `<Manga>Yes</Manga>` → RTL for manga only)
  + cover.
- 🗂️ **Packaging modes** per series: one CBZ **per chapter/issue**, or wait until a
  **volume is complete** and package the whole volume/collection.
- ⏱️ **Scheduler** scans every X hours for new chapters/issues and processes the queue.
- 🧩 **Reader-native** naming/layout (`Series Vol. NN.cbz`, `Series #NNN.cbz`).
- 🗺️ **Smart volume mapping** — provider-tagged volumes are authoritative; units
  the source left untagged are assigned to *estimated* volumes (flagged in
  ComicInfo) so volume packaging still works for scanlations/issue runs.
- 🔔 **Notifications** via **ntfy** and/or **Discord** when media is added (or on failures).
- 📚 **Library reconciliation** — scans your existing CBZ library, detects what you
  already own (down to the chapter/issue, via MangaDex or ComicVine ids), marks it
  so it's never re-downloaded, and surfaces owned-but-untracked series to follow.

## Quick start

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env        # optional — defaults work out of the box
npm start                   # web UI on http://localhost:8787
```

Or with Docker (alongside Tome):

```bash
docker compose up -d        # see docker-compose.yml
```

Then open the UI, go to **Add**, search a title, and **Follow** it. The scheduler
(or **Scan now**) downloads chapters and writes CBZs into `OUTPUT_DIR` — point that
at Tome's `TOME_INCOMING_DIR` (Bindery) and enable `TOME_AUTO_IMPORT`.

## How it fits with Tome

```
mangas-binder  ──downloads + binds──►  OUTPUT_DIR (= Tome /bindery)  ──Tome import──►  /books ──reader
```

Finished files are written as `OUTPUT_DIR/{Series}/{Series} Vol. NN.cbz` with a
ComicInfo.xml inside — both of which Tome understands.

## CLI (one-off binding of already-downloaded chapters)

The original folder→CBZ binder is still available for local chapter folders:

```bash
npm run bind -- -m "Manga Title" -i ./chapters -o ./out
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design, data model, and
roadmap.

## Configuration

All settings have env defaults (see `.env.example`) and most are editable live in
the UI's **Settings** tab. Per-series monitor mode and packaging mode are set when
following and editable on the series detail page.

### Comics setup (ComicVine + GetComics)

1. Get a free **ComicVine API key** at <https://comicvine.gamespot.com/api> and paste
   it into **Settings → Sources → ComicVine** (or set `COMICVINE_API_KEY`). ComicVine
   is the metadata source; it rate-limits ~200 requests/resource/hour, so we throttle.
2. **GetComics** is enabled by default as the comic *file* source (DDL). You can override
   its base URL in Settings if the site moves domains (`GETCOMICS_BASE_URL`).
3. In **Add**, pick **ComicVine** as the source, search a series, and **Follow**. Comics
   default to one CBZ **per issue**; switch to *collected volume* packaging if you prefer.

Each source has a **Test** button in **Settings → Sources** that does a live reachability
+ credential check (e.g. confirms your ComicVine key is valid) and shows the result inline.

> GetComics is a third-party site whose markup changes without notice. If comic
> downloads stop resolving, the scraping lives in `src/providers/getcomics.js`
> (`parseSearchResults` / `extractDownloadLinks`) and is the only place to fix.
> Only **CBZ/ZIP** archives are supported — CBR (RAR) is rejected with a clear error.

### Language (English default, French backup)

The default language is **English** (`DEFAULT_LANGUAGE`, editable in Settings). When a
chapter isn't available in the series' language or in English, **French** is used as a
last-resort backup rather than the chapter being skipped. The preference order is
*series language → English → French → anything else*, applied both when listing chapters
and when picking which scanlation to download.

### MangaKatana fallback (page source when MangaDex fails)

MangaDex@Home occasionally can't serve a chapter (timeouts, missing pages). When enabled,
mangas-binder falls back to scraping **MangaKatana** for that same chapter — series are
still *followed* via MangaDex (keeping its volume + MangaUpdates data); MangaKatana only
supplies the missing page images. Matching is by title, cached per series.

MangaKatana is behind **Cloudflare**, so it requires a **FlareSolverr** container to clear
the challenge. FlareSolverr returns the solved HTML plus the `cf_clearance` cookie and
User-Agent, which we reuse for the image-CDN requests.

To enable:
1. Run FlareSolverr (e.g. `ghcr.io/flaresolverr/flaresolverr`) and put it on a Docker
   network shared with mangas-binder. The provided `docker-compose.yml` joins the external
   `proxy-net` network and defaults `FLARESOLVERR_URL=http://flaresolverr:8191/v1`
   (create it once with `docker network create proxy-net`). If not co-networked, point
   `FLARESOLVERR_URL` at the host, e.g. `http://<host-ip>:8191/v1`.
2. In **Settings → Sources**, enable **MangaKatana** (it's opt-in / disabled by default,
   being a ToS-sensitive scraper) and optionally set its request **throttle** (ms).
3. Turn on **manga fallback** (`MANGA_FALLBACK_ENABLED` / the `mangaFallbackEnabled`
   setting). Use the **Test** button to confirm MangaKatana is reachable through FlareSolverr.

> MangaKatana is a third-party site whose markup changes without notice. The scraping lives
> in `src/providers/mangakatana.js` (`parseSearchResults` / `parseChapterList` /
> `parseChapterImages`) and is the only place to fix. Downloaded pages are validated by
> magic bytes, so a Cloudflare challenge page served as an "image" is rejected and retried.

### Library reconciliation (already-owned detection)

mangas-binder scans your CBZ library to avoid re-fetching what you already have:

- **What it reads:** for CBZs it produced, chapter/issue membership is encoded in the
  page names (`ch0012_p003.jpg`), and the series is matched via the MangaDex **or
  ComicVine** id stored in ComicInfo's `<Web>` tag (falling back to the series title).
  The **volume comes from the existing filename** (`… Vol. 05.cbz`) and is adopted as
  authoritative — so volume boundaries snap to what's already in your library.
- **What it does:** marks those chapters `imported` (pointing at the existing file),
  so the downloader/binder skip them entirely.
- **When:** automatically when you follow a series and on every scheduler cycle;
  manually via **Scan library** in the UI or `POST /api/library/scan`.
- **Scope:** point `LIBRARY_SCAN_DIRS` at your output dir and/or Tome's `/books`.
  Foreign CBZs (not made by mangas-binder) are matched by series/volume but can't be
  reconciled per-chapter, since they don't list chapter numbers.

### Notifications

Set a **Discord webhook URL** and/or an **ntfy topic URL** (e.g. `https://ntfy.sh/my-topic`)
in Settings → Notifications, then hit **Send test**. You get pinged when a volume/chapter
is added to your library (and optionally on repeated failures).

## Tests

```bash
npm test        # node --test — covers volume mapping + packaging
```
