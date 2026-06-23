// Deep-dive preamble resolver. For a (kid, subject, topic) tuple,
// look up the kid's cached Lumi diagnosis (TUTOR_CACHE) and return
// the conceptual / common-mistake pattern that most clearly maps to
// the target topic. The result is rendered as the topic-side watchOut
// list in the LumiPreamble shown above the first quiz question.
//
// Why pattern-derived, not hand-written:
//   The same kid has DIFFERENT conceptual confusions in different
//   topics (Kaiyang's Heat trap is "conductors/insulators", his
//   Forces trap is "naming the force"). Hard-coding per (kid, topic)
//   doesn't scale; Lumi's workshop already produced the right
//   sentences for free, we just have to surface them.

import { TUTOR_CACHE } from "@/lib/tutor-cache";

// Keywords per syllabus topic. Used to score each cached pattern's
// "what" text against the combo's topic and pick the best match.
// Keep keyword lists tight — false positives across topics make Heat
// combos quote the Forces pattern by mistake.
const TOPIC_KEYWORDS: Record<string, string[]> = {
  "Heat energy and uses":
    ["heat", "conductor", "insulator", "temperature", "evaporation", "evaporates", "state change", "melt", "boil"],
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)":
    ["force", "forces", "friction", "gravity", "gravitational", "elastic", "spring", "weight"],
  "Energy conversion":
    ["energy convert", "energy conversion", "kinetic", "potential", "energy form", "energy is lost"],
  "Interaction of forces (Magnets)":
    ["magnet", "magnetic", "pole", "attraction", "repulsion"],
  "Reproduction in plants and animals":
    ["reproduction", "reproductive", "pollination", "pollinated", "fertilisation", "fertilization", "ovule", "anther", "stigma", "sperm", "ovary"],
  "Life cycles in plants and animals":
    ["life cycle", "germination", "germinate", "larva", "pupa", "tadpole", "egg to adult"],
  "Photosynthesis":
    ["photosynthesis", "photosynthesise", "chlorophyll", "chloroplast"],
  "Light energy and uses":
    ["light", "shadow", "shadows", "reflection", "reflect", "transparent", "translucent", "opaque"],
  "Electrical system and circuits":
    ["circuit", "bulb", "battery", "switch", "series", "parallel", "current", "electromagnet"],
  "Human respiratory and circulatory systems":
    ["heart rate", "breathing rate", "lungs", "respiratory", "circulatory", "blood", "alveoli", "exercise"],
  "Water cycle, evaporation, condensation":
    ["water cycle", "evaporation", "condensation", "precipitation", "mist", "fog"],
  "Plant parts and functions":
    ["xylem", "phloem", "stomata", "transpiration", "root", "leaf", "stem"],
  "Cycles in matter":
    ["solid", "liquid", "gas", "matter", "volume", "displacement"],
  "Diversity of living and non-living things":
    ["classification", "vertebrate", "invertebrate", "fungi", "bacteria", "mammal", "reptile"],
  "Diversity of materials":
    ["material", "property", "flexible", "waterproof", "transparent", "strong"],
  "Human digestive system":
    ["digestion", "digest", "intestine", "stomach", "enzyme", "absorption", "oesophagus"],
  "Interactions within the environment":
    ["food web", "food chain", "habitat", "predator", "prey", "decomposer", "adaptation"],
};

// Convert a DB user.name into the TUTOR_CACHE key shape used by the
// workshop. Mirrors what scripts/_do-*-workshop.ts writes when
// snapshotting Gemini output to disk.
function safeNameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export type DeepDivePreamble = {
  heading: string;
  watchOut: string[];
};

// Read the kid's cached patterns and pick the one that matches the
// target topic best. Returns null if no cache entry or no pattern
// scores above zero (e.g. P5 kid with a topic Lumi never diagnosed).
export function getDeepDivePreamble(
  studentName: string,
  subject: "science" | "math" | "english",
  topic: string,
): DeepDivePreamble | null {
  const key = `${safeNameSlug(studentName)}:${subject}`;
  const cached = TUTOR_CACHE[key];
  if (!cached) return null;
  // TUTOR_CACHE entries have many shapes (unified-diagnosis output vs
  // legacy bucketed). We only consume `patterns[]` here — the unified
  // shape — since that's the only one with the rich "what" text per
  // gap. Other shapes return null and the endpoint falls back to the
  // static topicRecap on the combo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patterns = (cached as any).patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;

  const keywords = TOPIC_KEYWORDS[topic];
  if (!keywords) return null;

  // Score each pattern: count how many keywords appear in its "what"
  // text. Highest score wins.
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < patterns.length; i++) {
    const what = ((patterns[i].what as string) ?? "").toLowerCase();
    if (!what) continue;
    let score = 0;
    for (const kw of keywords) if (what.includes(kw)) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return null;

  const p = patterns[best];
  const what = (p.what as string) ?? "";
  const advice = (p.advice as string) ?? "";
  // Split the pattern's prose into short bullets — the watchOut
  // renderer expects a list. A pattern's "what" is usually a single
  // sentence listing 2-3 confusions; split on commas/semicolons works
  // well enough for v1 and gives the reader scannable bullets.
  const fragments = [what, advice].filter(s => s && s.trim().length > 0).join(" ");
  const bullets = fragments
    .split(/[;.](?:\s+|$)|,\s+(?=[A-Z])/)
    .map(s => s.replace(/^\s*and\s+/i, "").trim())
    .filter(s => s.length > 8)
    .slice(0, 4);
  // Heading uses the topic short-name. Most topics' titles work
  // verbatim; trim the parenthetical for the long Forces ones.
  const heading = topic
    .replace(/\s*\([^)]*\)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { heading, watchOut: bullets.length > 0 ? bullets : [what] };
}
