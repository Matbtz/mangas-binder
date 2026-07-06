function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(name, value) {
  if (value === null || value === undefined || value === '') return null;
  return `  <${name}>${escXml(value)}</${name}>`;
}

/** Strip Markdown links/bold from MangaDex descriptions, return first paragraph. */
function cleanDescription(text) {
  if (!text) return '';
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // **bold** → bold
    .replace(/\n{3,}/g, '\n\n')                // collapse blank lines
    .split('\n\n')[0]                           // first paragraph only
    .trim();
}

/**
 * Sort name for a series: drop a leading English article so "The Promised
 * Neverland" files under P, not T. Kept ASCII-simple on purpose — this only
 * needs to satisfy Kavita/Komga's alphabetical grouping, not full i18n.
 */
export function seriesSortName(series) {
  return String(series ?? '').replace(/^\s*(the|a|an)\s+/i, '').trim();
}

/**
 * Build a ComicInfo.xml string (v2.0 spec).
 * https://anansi-project.github.io/docs/comicinfo/schemas/v2.0
 *
 * Optional enrichment (emitted only when supplied):
 *  - `totalVolumes` → <Count> so Kavita/Komga can show a "have N of M volumes"
 *    progress badge (the cross-provider total-volume consensus).
 *  - `volumeTitle`  → the localized tankōbon title for this volume (e.g. from a
 *    Wikipedia chapter-list table) instead of the generic "<Series>, Vol. N".
 *  - `localizedSeries`, `translators`, `ageRating` → richer library filtering.
 */
export function buildComicInfoXml({
  series,
  volumeNum,
  number,
  title,
  volumeTitle = '',
  authors = [],
  artists = [],
  translators = [],
  description = '',
  genres = [],
  year,
  mangadexId,
  web,
  publisher,
  mediaType = 'manga',
  isCalculated = false,
  language = 'en',
  totalVolumes = null,
  localizedSeries = '',
  ageRating = '',
}) {
  const isComic = mediaType === 'comic';
  const volLabel = (volumeNum && volumeNum !== 'none') ? String(volumeNum) : '';
  // Chapter/issue mode: Number is the chapter/issue. Volume mode: Number is the volume.
  const chapterLabel = (number !== undefined && number !== null && number !== '') ? String(number) : '';
  const numberValue = chapterLabel || volLabel;
  const unit = isComic ? '#' : 'Ch. ';
  const autoTitle = chapterLabel
    ? `${series} ${unit}${chapterLabel}`
    : (volLabel ? `${series}, Vol. ${volLabel}` : series);
  // In volume mode, prefer the real localized tankōbon title when we have one
  // (e.g. "Romance Dawn" for One Piece vol 1) over the generic auto-title.
  const explicitTitle = (title && String(title).trim()) ? String(title).trim()
    : (!chapterLabel && volumeTitle && String(volumeTitle).trim() ? String(volumeTitle).trim() : '');
  const titleStr = explicitTitle || autoTitle;
  const writersStr = [...new Set(authors)].join(', ');
  const pencillersStr = [...new Set(artists)].join(', ');
  // Only output Penciller if different from Writer (for manga they're usually the same)
  const pencillerLine = pencillersStr && pencillersStr !== writersStr ? pencillersStr : null;
  const translatorsStr = [...new Set(translators)].filter(Boolean).join(', ');
  const genreStr = genres.join(', ');
  const sortName = seriesSortName(series);
  const seriesSortLine = sortName && sortName !== String(series) ? sortName : null;
  const notes = isCalculated
    ? (isComic
        ? 'Collection boundaries are estimated — calculated from known issues-per-volume average.'
        : 'Volume boundaries are estimated — calculated from known chapters-per-volume average.')
    : '';
  const webUrl = web || (mangadexId ? `https://mangadex.org/title/${mangadexId}` : '');

  const countValue = (totalVolumes != null && Number(totalVolumes) > 0) ? Math.floor(Number(totalVolumes)) : null;

  const lines = [
    tag('Series', series),
    tag('LocalizedSeries', localizedSeries),
    tag('SeriesSort', seriesSortLine),
    numberValue ? tag('Number', numberValue) : null,
    (chapterLabel && volLabel) ? tag('Volume', volLabel) : null,
    // <Count> = total volumes in the series → Kavita/Komga "N of M" progress.
    countValue ? tag('Count', countValue) : null,
    tag('Title', titleStr),
    tag('Summary', cleanDescription(description)),
    tag('Publisher', publisher),
    tag('Year', year),
    tag('Writer', writersStr),
    tag('Penciller', pencillerLine),
    tag('Translator', translatorsStr),
    tag('Genre', genreStr),
    tag('AgeRating', ageRating),
    tag('LanguageISO', language),
    // Manga are typically B&W and read right-to-left; comics are colour, left-to-right.
    isComic ? null : '  <BlackAndWhite>Yes</BlackAndWhite>',
    // YesAndRightToLeft (not just "Yes") so readers apply Japanese RTL pagination
    // instead of defaulting to western left-to-right — critical for manga layout.
    isComic ? null : '  <Manga>YesAndRightToLeft</Manga>',
    tag('Web', webUrl),
    tag('Notes', notes),
  ].filter(Boolean);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    ...lines,
    '</ComicInfo>',
  ].join('\n');
}
