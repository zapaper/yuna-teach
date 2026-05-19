// Stem-based classifier for the Patterns master class — maps a
// question to one of the sub-topics defined in patterns.yaml. Used
// when copying questions into a mastery paper so that per-sub-topic
// mastery tracking works for Patterns (which doesn't have admin-
// tagged sub-topics on its source questions).
//
// Sub-topic IDs (must match patterns.yaml):
//   constant-difference    — every step adds / subtracts the same amount
//   changing-difference    — differences grow, flip, or interleave
//   string-of-symbols      — repeating letters / beads / nth-term cycle
//   figure-patterns        — Figure 1, 2, 3 with objects growing
//
// Returns a sub-topic id or null when nothing matches.
export function classifyPatternQuestion(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem.toLowerCase();

  // Composed-shape questions (4 identical triangles forming a bowtie,
  // etc.) are routed to figure-patterns — the technique (table → rule
  // → formula) is the same as any other figure pattern. We dropped
  // the dedicated shape-patterns sub-topic when slide 8 became the
  // sticks worked example.
  if (/\bidentical\b.*(triangle|square|rectangle|shape)/.test(s)) return "figure-patterns";
  if (/(?:made up of|formed from|formed by|composed of)\s+\d+\s+(identical\s+)?(triangle|square|rectangle|shape)/.test(s)) return "figure-patterns";

  // Figure-based patterns with object counts. Two-colour figures
  // (grey / white / black / shaded etc.) live here too — the beads
  // worked example on slide 6 demonstrates the technique.
  if (/(grey|gray|white|black|shaded|unshaded).*(tile|circle|square|bead|dot)/.test(s)
   || /(tile|circle|square|bead|dot).*(grey|gray|white|black|shaded|unshaded)/.test(s)) {
    return "figure-patterns";
  }

  // String-of-symbols / nth-term — "what is the 80th letter", "the
  // 105th bead", etc.
  if (/the\s*\d+(st|nd|rd|th)\s*(figure|term|number|bead|letter)/.test(s)) return "string-of-symbols";
  if (/what\s+is\s+the\s+\d+(st|nd|rd|th)/.test(s)) return "string-of-symbols";
  if (/nth\s+term/.test(s)) return "string-of-symbols";
  // Pure repeating-sequence patterns (no Figure n labelling)
  if (/repeated pattern|repeating pattern|necklace|first \d+ (letter|bead)/.test(s)) return "string-of-symbols";

  // Figure-based — generic.
  if (/figure\s*\d/.test(s) || /each\s+figure/.test(s) || /the\s+(\d+)(st|nd|rd|th)\s+figure/.test(s)) {
    return "figure-patterns";
  }

  // Number sequences. Most fall into "constant difference" (linear).
  // Genuinely changing-difference sequences are hard to detect from
  // the stem alone — they need to look at the actual numbers. We
  // default to constant-difference and let an admin re-tag if needed.
  if (/missing\s+number/.test(s)) return "constant-difference";
  if (/number\s+pattern/.test(s)) return "constant-difference";
  if (/pattern\s+below/.test(s)) return "constant-difference";
  if (/sequence/.test(s)) return "constant-difference";

  // Last-resort fallback.
  return "constant-difference";
}
