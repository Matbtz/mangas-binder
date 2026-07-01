// Pure string-matching helpers with zero dependencies, so they can be safely
// imported from providers/* without pulling in core/library.js's settings ->
// providers/index.js chain (which would create a circular import).

/** Normalise a title for fuzzy comparison: lowercase, strip punctuation, collapse spaces. */
export function normTitle(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** True when two title strings are close enough to be the same series. */
export function titlesMatch(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}
