/**
 * Provider interface — every manga source implements this shape.
 *
 * A provider is a plain object (or class instance) exposing:
 *
 *   name          string   unique id, e.g. "mangadex"
 *   label         string   human label, e.g. "MangaDex"
 *   capabilities  { download: boolean, metadata: boolean }
 *
 * and the async methods below. Sources that only supply metadata
 * (e.g. MangaUpdates volume counts) set capabilities.download = false
 * and may omit getChapterPages / getVolumeCovers.
 *
 *   search(title)                  -> [{ id, title, year, cover }]
 *   getSeries(id)                  -> { title, authors, artists, genres,
 *                                       description, year, status, language }
 *   listChapters(id, { lang })     -> [{ id, number, volume|null, title,
 *                                        lang, publishedAt, pages|null }]
 *   getChapterPages(chapterId, opts)-> [imageUrl, ...]   (download providers only)
 *                                      OR [{ url, headers? }, ...] when a source
 *                                      needs per-request headers (Referer, Cookie,
 *                                      User-Agent). The downloader merges those
 *                                      headers over its default User-Agent.
 *   getVolumeCovers(id)            -> Map<volumeString, coverUrl>
 *
 * Capability flags beyond { download, metadata }:
 *   archive      — resolves a whole CBZ/ZIP per chapter (getcomics)
 *   pageFallback — supplies page images for a chapter identified by (series,
 *                  chapterNumber) rather than a provider chapter id; used only as
 *                  a fallback when the primary download provider fails (mangakatana)
 *
 * Chapter `number` and `volume` are strings ("12", "12.5") to preserve
 * decimal chapters; `volume` is null when the source has no assignment.
 */

/** @typedef {{ download: boolean, metadata: boolean }} Capabilities */

/**
 * Throwing stub so partial providers fail loudly rather than silently.
 * @param {string} name
 */
export function unsupported(name) {
  return async () => {
    throw new Error(`Provider does not support "${name}"`);
  };
}
