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
 *   getVolumeCovers(id)            -> Map<volumeString, coverUrl>
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
