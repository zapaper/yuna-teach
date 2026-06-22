// PSLE 2025/2026 syllabus removals -- topics MOE pulled out of the
// PSLE syllabus that we now exclude from kid-facing quiz / focused-
// practice pools. Full-paper assignments (regular Prelim / EOY
// papers) still ship them as-is, since real-world papers in our bank
// pre-date the removal and we don't want to mangle them.
//
//   - Cells   (Science, P5)  -- standalone Cells topic gone; cell
//                                anatomy terms (cell wall, cytoplasm,
//                                chloroplast, plant/animal cell) no
//                                longer assessed
//   - Speed   (Math, P6)     -- entire topic moved to Secondary 1
//   - Compass (Math, P4)     -- "Turns and 8-point Compass" under
//                                the Angles topic removed
//
// Source: MOE/SEAB syllabus updates announced for the 2026 PSLE
// cohort (and English oral format change from 2025; English isn't
// included here because no content topics were removed -- only the
// oral exam format changed).

export const LEGACY_TOPICS = ["Cells", "Speed", "Compass"] as const;
export type LegacyTopic = typeof LEGACY_TOPICS[number];

// Subject -> applicable legacy topics. Used both by the detection
// sweep (only scan Science questions for Cells candidates) and by
// any future per-subject reporting.
export const LEGACY_TOPIC_SUBJECT: Record<LegacyTopic, "science" | "math"> = {
  Cells: "science",
  Speed: "math",
  Compass: "math",
};

// Detection regex per topic -- tuned for high precision on the
// strong signals. False positives are expected on edge cases and
// get filtered out by admin review before the re-tag is persisted.
// Tighten / loosen these directly when iterating; the admin panel
// reads them live on each GET.
export const LEGACY_TOPIC_DETECTOR: Record<LegacyTopic, RegExp> = {
  Cells: /\b(cell\s+(wall|membrane|nucleus|cytoplasm|division|organelle|sample)|cytoplasm|chloroplast|nuclei\b|plant\s+cell|animal\s+cell|cell\s+(?:diagram|shown|labeled|labelled)|under\s+(?:the\s+)?microscope.*cell|basic\s+unit\s+of\s+life|onion\s+cell|leaf\s+cell|root\s+(?:hair\s+)?cell)/i,
  Speed: /\b(km\s*\/\s*h|m\s*\/\s*s|cm\s*\/\s*s|metres?\s+per\s+second|kilometres?\s+per\s+hour|average\s+speed|constant\s+speed|speed\s+of\s+\d|at\s+a\s+speed|travel(?:led|s|ling)?\s+at\s+\d|speed[-\s]time\s+graph|distance[-\s]time\s+graph)/i,
  // Tight Compass detector: the stem must contain either an
  // explicit compound direction (north-east etc.), the word
  // "compass" / "bearing" / "direction", OR a full directional
  // word (north/south/east/west) in an unambiguous directional
  // phrase ("facing north", "due south", "X north of Y"). Bare
  // "north"/"south"/"east"/"west" without that surrounding context
  // is excluded to avoid matching proper-noun usages. Dotted
  // abbreviations (N.E., S.W.) only match with mandatory periods.
  // Pure two-letter forms (NE, SW, NW, SE) are dropped entirely --
  // they false-positive on "nearest", "semicircle", "net", and any
  // base64 substring in transcribedSubparts diagramBase64 fields.
  Compass: /\b(?:north[-\s]?(?:east|west)\b|south[-\s]?(?:east|west)\b|compass(?:\s+(?:rose|point|direction))?\b|bearing\b|8[-\s]point\s+compass\b|eight[-\s]point\s+compass\b|(?:facing|due|directly)\s+(?:north|south|east|west)\b|(?:north|south|east|west)\s+of\s+(?:the\s+)?\w+|in\s+(?:what|which)\s+direction\b|N\.E\.|N\.W\.|S\.E\.|S\.W\.)/i,
};

// Pull every searchable string off a question into one blob so the
// regex covers stem + options + subparts + table options. Used by
// the admin review panel and any future batch-tag tooling.
export function questionTextBlob(q: {
  transcribedStem?: string | null;
  transcribedOptions?: unknown;
  transcribedSubparts?: unknown;
  transcribedOptionTable?: unknown;
}): string {
  return [
    q.transcribedStem ?? "",
    JSON.stringify(q.transcribedOptions ?? ""),
    JSON.stringify(q.transcribedSubparts ?? ""),
    JSON.stringify(q.transcribedOptionTable ?? ""),
  ].join(" ");
}
