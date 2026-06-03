// Stem-based classifier for the Geometry Mastery master class — maps
// a question to one of the three sub-topics. Called at clone time to
// tag the mastery-quiz's cloned question rows.
//
// Sub-topic IDs (must match math-geometry-mastery.yaml):
//   nets                 — net of a cuboid / prism / pyramid / cylinder
//   symmetry-reflection  — line of symmetry, reflection, folded-paper angle
//   shape-property       — angle hunt in parallelogram / rhombus / trapezium /
//                          isosceles (the "level 2" of math-geometry-angles)
//
// Order matters: nets is the most specific (rare keyword), then
// symmetry/reflection (also distinctive), then shape-property as the
// catch-all for the named quadrilateral/triangle angle questions.
export function classifyGeometryMastery(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem.toLowerCase();

  // ─── Nets of solids ──────────────────────────────────────────
  // "net of" / "net was folded" / "cube net" / "fold into"
  if (/\bnet\s+(?:of|was|is|can|cannot|could)\b/.test(s)) return "nets";
  if (/\bnet\s+below\b|\bnet\s+above\b|\bnet\s+shown\b/.test(s)) return "nets";
  if (/(?:folded|unfolded)\s+(?:into|to\s+form|to\s+make)\s+(?:a|the)\s+(?:cube|cuboid|prism|pyramid|cylinder|solid)/.test(s)) return "nets";
  if (/which\s+(?:of\s+(?:the\s+)?)?(?:nets?|figures?)\s+(?:below|above|shown).{0,80}\b(?:cube|cuboid|prism|pyramid)\b/.test(s)) return "nets";

  // ─── Symmetry / reflection / folded paper ────────────────────
  // Symmetry vocabulary; folded-paper PSLE-style questions
  if (/\bline[s]?\s+of\s+symmetry\b|\baxis\s+of\s+symmetry\b/.test(s)) return "symmetry-reflection";
  if (/\bsymmetr(?:y|ic|ical)\b/.test(s)) return "symmetry-reflection";
  if (/\breflect(?:ion|ed)\b/.test(s)) return "symmetry-reflection";
  // Folded-paper angle question — the fold creates a new figure and
  // the question asks about an angle on it. Distinguished from "net
  // folded into a cube" by the absence of solid-shape keywords.
  if (/\bfolded\b/.test(s) && /\bangle|∠/.test(s)) return "symmetry-reflection";
  if (/folded\s+along\b/.test(s)) return "symmetry-reflection";

  // ─── Shape-property angle hunt ───────────────────────────────
  // Named quadrilateral or isosceles triangle + asks for an angle.
  if (/(parallelogram|rhombus|trapezium|isosceles)/.test(s) && /\bangle|∠/.test(s)) return "shape-property";
  // Generic "find the angle" with a quadrilateral-style figure
  // (ABCD / PQRS named four-corner shape).
  if (/\babcd\b|\bpqrs\b|\bwxyz\b/i.test(s) && /\bangle|∠/.test(s) && /quadrilateral|four[\s-]?sided/.test(s)) return "shape-property";

  return null;
}
