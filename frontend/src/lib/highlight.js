/**
 * Locate a model-supplied quote inside the original record text.
 *
 * The model returns quotes on a single line, but PDF-extracted text is full of hard
 * line breaks mid-sentence. A raw `indexOf` therefore misses most genuine verbatim
 * quotes, measured at 2/7 on a real record, versus 6/6 once whitespace is
 * normalized. So we normalize both sides for the search, while keeping an index map
 * back to the ORIGINAL string so the highlight lands on the real characters.
 */

/**
 * Build a whitespace-collapsed copy of `text` plus a map from each normalized
 * character index back to its index in the original.
 */
function normalizeWithMap(text) {
  let normalized = "";
  const map = [];
  let pendingSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      // Collapse any whitespace run to a single space, but only once we've
      // emitted a real character (so leading whitespace is dropped entirely).
      if (normalized.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      map.push(i);
      pendingSpace = false;
    }
    normalized += ch.toLowerCase();
    map.push(i);
  }

  return { normalized, map };
}

/**
 * Find `quote` within `source`, tolerating whitespace and case differences.
 *
 * @returns {{start: number, end: number} | null} indices into the ORIGINAL source
 */
export function findQuoteSpan(source, quote) {
  if (!source || !quote) return null;

  const { normalized, map } = normalizeWithMap(source);
  const needle = quote.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return null;

  let at = normalized.indexOf(needle);

  // Models sometimes truncate a long quote or trail off mid-clause. Retry with a
  // shrinking prefix so a partial quote still anchors somewhere useful rather than
  // silently failing to highlight.
  if (at === -1) {
    for (const fraction of [0.75, 0.5, 0.35]) {
      const prefix = needle.slice(
        0,
        Math.max(24, Math.floor(needle.length * fraction)),
      );
      if (prefix.length < 12) break;
      at = normalized.indexOf(prefix);
      if (at !== -1) {
        const start = map[at];
        const endIdx = Math.min(at + prefix.length - 1, map.length - 1);
        return { start, end: map[endIdx] + 1, partial: true };
      }
    }
    return null;
  }

  const start = map[at];
  const endIdx = Math.min(at + needle.length - 1, map.length - 1);
  return { start, end: map[endIdx] + 1, partial: false };
}

/**
 * Split `source` into segments for rendering, marking the located quote.
 *
 * @returns {Array<{text: string, match: boolean}>}
 */
export function segmentsForQuote(source, quote) {
  const span = findQuoteSpan(source, quote);
  if (!span) return [{ text: source, match: false }];
  return [
    { text: source.slice(0, span.start), match: false },
    { text: source.slice(span.start, span.end), match: true },
    { text: source.slice(span.end), match: false },
  ].filter((seg) => seg.text.length > 0);
}
