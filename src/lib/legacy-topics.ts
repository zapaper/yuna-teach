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
  // Compass abbreviations are only included with mandatory dots
  // ("N.E.") or all-caps boundary ("NE" in a directional context).
  // Bare lowercase "ne"/"sw" matches too many ordinary words
  // ("line", "stone", "saw"), so we rely on the full-word forms
  // ("north-east", "south-west") for high-confidence hits.
  Compass: /\b(north[-\s]east|north[-\s]west|south[-\s]east|south[-\s]west|N\.?\s*E\.?|N\.?\s*W\.?|S\.?\s*E\.?|S\.?\s*W\.?|8[-\s]point\s+compass|eight[-\s]point\s+compass|compass\s+(?:rose|point|direction)|turn(?:s|ing)?\s+(?:clockwise|anti-?clockwise).*(?:north|south|east|west)|facing\s+(?:north|south|east|west))/i,
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
