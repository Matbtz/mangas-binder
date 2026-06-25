# mangas-binder

A lightweight, self-hosted **"Sonarr/Radarr for manga"**. Follow series, download
chapters from configurable sources, bind them into **CBZ volumes with ComicInfo.xml
+ cover**, and hand them off to a **[Tome](https://github.com/bndct-devops/tome)**
library for reading.

mangas-binder is the *acquisition + binding* half (the "Sonarr"); Tome is the
*library + reader*. They talk through a shared folder — mangas-binder drops
Tome-ready CBZs into Tome's Bindery inbox.

> ⚠️ **Personal archival tool.** Bulk-downloading from aggregator APIs generally
> violates their terms of service. mangas-binder rate-limits politely and keeps
> sources pluggable so you own that choice. Use responsibly.

## Features

- 🔎 **Follow series** from a source (MangaDex built in) via a simple web UI.
- ⚙️ **Enable/disable sources** — pluggable provider interface.
- ⬇️ **Downloader** fetches page images with concurrency, retry/backoff, resume.
- 📦 **Binds to CBZ** with embedded `ComicInfo.xml` (Series, Number, Volume,
  authors, genres, summary, `<Manga>Yes</Manga>` → Tome RTL) + volume cover.
- 🗂️ **Packaging modes** per series: one CBZ **per chapter**, or wait until a
  **volume is complete** and package the whole volume.
- ⏱️ **Scheduler** scans every X hours for new chapters and processes the queue.
- 🧩 **Tome-native** naming/layout so Tome ingests cleanly.
- 🗺️ **Smart volume mapping** — provider-tagged volumes are authoritative; chapters
  the source left untagged are assigned to *estimated* volumes (and flagged as such
  in ComicInfo) so volume packaging still works for scanlations.
- 🔔 **Notifications** via **ntfy** and/or **Discord** when media is added (or on failures).

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

### Notifications

Set a **Discord webhook URL** and/or an **ntfy topic URL** (e.g. `https://ntfy.sh/my-topic`)
in Settings → Notifications, then hit **Send test**. You get pinged when a volume/chapter
is added to your library (and optionally on repeated failures).

## Tests

```bash
npm test        # node --test — covers volume mapping + packaging
```
