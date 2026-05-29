// Stem-based classifier for the Hidden Constant Total master class —
// maps a question to one of the sub-topics in
// math-hidden-constant-total.yaml. Called at clone time to tag the
// mastery-quiz's cloned question rows.
//
// Only TWO sub-topics survive in this taxonomy: Pattern A (internal
// transfer) and Pattern D (equalise ratios). B (equal removal) and C
// (one quantity unchanged) are kept as TEACHING slides but PSLE's
// actual question bank doesn't separate them cleanly from A/D, so
// the picker only pulls from A + D.
//
// Sub-topic IDs (must match math-hidden-constant-total.yaml):
//   internal-transfer  — "X gave $N to Y", give-and-take
//   equalise-ratios    — "ratio of A:B was X:Y, became X':Y'"
export function classifyHiddenConstantTotal(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem.toLowerCase();

  // ─── D first (more specific) — equalise-ratios ───────────────
  // Use [\s\S] (any char incl. newlines + periods) since most PSLE
  // ratio problems span multiple sentences ("…ratio is 3:4. After…
  // the ratio became 1:2"). [^.] would stop at the first sentence
  // boundary and miss the second ratio mention.
  if (/\bratio\b[\s\S]{0,400}\b(?:became|changed|is now|will be)\b/.test(s)) return "equalise-ratios";
  if (/\bnew\s+ratio\b/.test(s)) return "equalise-ratios";
  // Two distinct ratio mentions in the same problem.
  const ratioMentions = (s.match(/\b(?:in the ratio|ratio of)\b/g) ?? []).length;
  if (ratioMentions >= 2) return "equalise-ratios";

  // ─── A — internal-transfer ───────────────────────────────────
  // External give-aways disqualify: "gave away", "donated", "sold",
  // "ate", "drank", or recipients that aren't named individuals
  // ("to her 7 cousins", "to his pupils", "to friends").
  const isExternalGiveAway = /\bgave\s+away\b|\bdonated\b|\bsold\b|\bate\s+(?:\d|some|all|the|her|his)\b|\bdrank\b/.test(s)
    || /\bto\s+(?:her|his|the|each\s+of\s+(?:her|his|the))?\s*(?:\d+\s+)?(?:friends?|cousins?|relatives?|pupils?|children|class(?:mates)?|family|sisters?|brothers?|nephews?|nieces?|guests?|charit(?:y|ies))\b/.test(s);

  // "X gave [...] to Y" with capitalised names on both ends — use
  // the ORIGINAL stem (case preserved) so we can check capitals.
  const namedTransfer = /\b[A-Z][a-z]+\s+gave\b[\s\S]{0,250}\bto\s+[A-Z][a-z]+\b/.test(stem);
  // Sequential transfers: "A gave B... then B gave A..." (Andy/Betty,
  // Limin→Ming→Raju). Spans across sentences.
  const sequentialTransfer = /\b[A-Z][a-z]+\s+gave\b[\s\S]{0,300}\b[A-Z][a-z]+\s+gave\b/.test(stem);
  // "Shared between A and B" + later "gave" phrasing (Ali/John style).
  const sharedTransfer = /\b(?:shared|split|divided)\b[\s\S]{0,100}\b(?:between|among)\b[\s\S]{0,400}\bgave\b/.test(s);

  if ((namedTransfer || sequentialTransfer || sharedTransfer) && !isExternalGiveAway) {
    return "internal-transfer";
  }
  return null;
}
