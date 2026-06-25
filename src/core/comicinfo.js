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
 * Build a ComicInfo.xml string (v2.0 spec).
 * https://anansi-project.github.io/docs/comicinfo/schemas/v2.0
 */
export function buildComicInfoXml({
  series,
  volumeNum,
  number,
  authors = [],
  artists = [],
  description = '',
  genres = [],
  year,
  mangadexId,
  isCalculated = false,
  language = 'en',
}) {
  const volLabel = (volumeNum && volumeNum !== 'none') ? String(volumeNum) : '';
  // Chapter mode: no Volume, Number is the chapter. Volume mode: Number is the volume.
  const chapterLabel = (number !== undefined && number !== null && number !== '') ? String(number) : '';
  const numberValue = chapterLabel || volLabel;
  const title = chapterLabel
    ? `${series}, Ch. ${chapterLabel}`
    : (volLabel ? `${series}, Vol. ${volLabel}` : series);
  const writersStr = [...new Set(authors)].join(', ');
  const pencillersStr = [...new Set(artists)].join(', ');
  // Only output Penciller if different from Writer (for manga they're usually the same)
  const pencillerLine = pencillersStr && pencillersStr !== writersStr ? pencillersStr : null;
  const genreStr = genres.join(', ');
  const notes = isCalculated
    ? 'Volume boundaries are estimated — calculated from known chapters-per-volume average.'
    : '';
  const web = mangadexId ? `https://mangadex.org/title/${mangadexId}` : '';

  const lines = [
    tag('Series', series),
    numberValue ? tag('Number', numberValue) : null,
    (chapterLabel && volLabel) ? tag('Volume', volLabel) : null,
    tag('Title', title),
    tag('Summary', cleanDescription(description)),
    tag('Year', year),
    tag('Writer', writersStr),
    tag('Penciller', pencillerLine),
    tag('Genre', genreStr),
    tag('LanguageISO', language),
    `  <BlackAndWhite>Yes</BlackAndWhite>`,
    `  <Manga>Yes</Manga>`,
    tag('Web', web),
    tag('Notes', notes),
  ].filter(Boolean);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    ...lines,
    '</ComicInfo>',
  ].join('\n');
}
