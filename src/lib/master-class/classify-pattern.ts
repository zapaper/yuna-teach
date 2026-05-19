// Stem-based classifier for the Patterns master class — maps a
// question to one of the sub-topics defined in patterns.yaml. Used
// when copying questions into a mastery paper so that per-sub-topic
// mastery tracking works for Patterns (which doesn't have admin-
// tagged sub-topics on its source questions).
//
// Returns a sub-topic id or null when nothing matches.
export function classifyPatternQuestion(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem.toLowerCase();

  // Shape composition first: phrases like "identical right-angled
  // triangles", "made up of N triangles" — strong signal.
  if (/\bidentical\b.*(triangle|square|rectangle|shape)/.test(s)) return "shape-composition";
  if (/(?:made up of|formed from|formed by|composed of)\s+\d+\s+(identical\s+)?(triangle|square|rectangle|shape)/.test(s)) return "shape-composition";

  // Two-colour figures.
  if (/(grey|gray|white|black|shaded|unshaded).*(tile|circle|square|bead|dot)/.test(s)
   || /(tile|circle|square|bead|dot).*(grey|gray|white|black|shaded|unshaded)/.test(s)) {
    return "two-colour-figures";
  }

  // nth term — "what is the 80th letter", "the 105th bead", etc.
  if (/the\s*\d+(st|nd|rd|th)\s*(figure|term|number|bead|letter)/.test(s)) return "nth-term";
  if (/what\s+is\s+the\s+\d+(st|nd|rd|th)/.test(s)) return "nth-term";
  if (/nth\s+term/.test(s)) return "nth-term";

  // Figure-based object counting.
  if (/figure\s*\d/.test(s) || /each\s+figure/.test(s) || /the\s+(\d+)(st|nd|rd|th)\s+figure/.test(s)) {
    return "figure-objects";
  }

  // Number sequences. Many of these will be "differences-method"
  // (linear). If the sequence visibly mixes operations (sub-patterns),
  // it's "hidden-subpatterns" — but that's hard to detect from the
  // stem alone, so default to differences-method.
  if (/missing\s+number/.test(s)) return "differences-method";
  if (/number\s+pattern/.test(s)) return "differences-method";
  if (/pattern\s+below/.test(s)) return "differences-method";
  if (/sequence/.test(s)) return "differences-method";

  // Last-resort fallback so the question still tracks against SOME
  // sub-topic. differences-method is the broadest catch-all.
  return "differences-method";
}
