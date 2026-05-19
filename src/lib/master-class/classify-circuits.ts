// Stem-based classifier for the Electrical Circuits master class —
// maps a question to one of the sub-topics defined in
// electrical-circuits.yaml. Called when copying source questions into
// a mastery paper so per-sub-topic mastery tracking works.
//
// Sub-topic IDs (must match electrical-circuits.yaml):
//   series-vs-parallel     — which bulb blew, fuse behaviour, series vs parallel structure
//   bulb-brightness        — comparing brightness across circuits
//   electromagnets         — coil + iron core OEQs (bell, buzzer, door lock, etc.)
//   general-circuits       — catch-all: diagram reading basics, open/closed identification, junction traps
//
// Returns a sub-topic id, defaulting to "general-circuits" when no
// sharper bucket matches.
export function classifyCircuitsQuestion(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem.toLowerCase();

  // Electromagnets — strongest signal first. Look for the coil + iron
  // core phrasings that show up across bell / buzzer / door lock /
  // door bolt OEQs.
  if (/\b(electromagnet|wire coil(?:ed)?|coil of wire|coiled around|metal cylinder.*coil|coil.*metal cylinder)\b/.test(s)) return "electromagnets";
  if (/\biron (bolt|bar|rod|rods|nail|nails|core)\b/.test(s) && /\b(switch|circuit|current|battery)\b/.test(s)) return "electromagnets";

  // Bulb brightness — explicit brightness comparisons.
  if (/\bbright(er|est|ness)\b/.test(s)) return "bulb-brightness";
  if (/\bsame brightness\b/.test(s)) return "bulb-brightness";
  if (/\bequal brightness\b/.test(s)) return "bulb-brightness";

  // Series vs Parallel — fuse / blown bulb scenarios, "did not light
  // up", "more bulbs will light up".
  if (/\b(blown|fused|fuse[ds]?)\b.*\bbulb\b/.test(s)) return "series-vs-parallel";
  if (/\bbulb\b.*\b(blown|fused|fuse[ds]?)\b/.test(s)) return "series-vs-parallel";
  if (/\bseries\b|\bparallel\b/.test(s)) return "series-vs-parallel";
  if (/\bnot? light up\b/.test(s) && /\bbulb\b/.test(s)) return "series-vs-parallel";
  if (/\bhow many.*bulb.*light up\b/.test(s)) return "series-vs-parallel";

  // Catch-all: open/closed circuit, identifying components, junction
  // traps, fault diagnosis without an explicit fuse story.
  return "general-circuits";
}
