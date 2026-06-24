// Per-combo rationale composer. Replaces the static `rationale` text
// on LumiQuizCombo with a sentence that describes what THIS quiz will
// drill for THIS kid, derived from:
//   · combo.subTopicWeights — top sub-topics the picker will weight
//   · kid's cached Lumi diagnosis (TUTOR_CACHE) — common-mistake
//     pattern that anchors to the combo's topic
//
// Output shape (from feature spec):
//   "This quiz will focus on subtopics X and Y, where {kid} seems
//    weaker. I've also paired it with questions that address {kid}'s
//    common mistake of {pattern-derived short phrase}."
//
// Client-safe — only imports JSON and small constants. No Gemini SDK,
// no Prisma, no env reads. Lives separate from lumi-deepdive.ts so
// the bundle for the parent dashboard doesn't pull the server-only
// reframe pipeline.

import { TUTOR_CACHE } from "@/lib/tutor-cache";

// Same TOPIC_KEYWORDS list as in lumi-deepdive.ts. Duplicated to keep
// this file client-safe (lumi-deepdive imports Gemini). If a future
// pass needs to keep these in sync, factor out into a shared constant
// file with no other imports.
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

function safeNameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Turn a sub-topic kebab id into a short, prose-friendly phrase.
// E.g. "identifying-and-representing-forces" → "identifying and
// representing forces". Good enough for inline mention; we don't
// pull from SCIENCE_SUBTOPIC_TAXONOMY here because the long bucket
// descriptions read awkwardly inside a sentence.
function humaniseSubTopic(id: string): string {
  return id.replace(/-/g, " ");
}

// Reformat the workshop pattern's "what" text so the kid's first name
// can be substituted in — turns "The student sometimes confuses X
// with Y." into "sometimes confuses X with Y" so the caller can build
// "...the pattern Lumi keeps seeing: <kid> sometimes confuses X with Y."
// Keeps the original verb form (lighter touch than trying to convert
// "tends to identify" into "identifying" via regex — that produced
// awkward output like "of identify the obvious solid objects").
function reframeMistake(what: string): string {
  return what
    .trim()
    .replace(/^\s*The student\s+/i, "")
    .replace(/[.!?]+$/, "")
    .replace(/^\s*[A-Z]/, m => m.toLowerCase())
    .trim();
}

function pickPatternForTopic(studentName: string, subject: "science", topic: string): string | null {
  const key = `${safeNameSlug(studentName)}:${subject}`;
  const cached = TUTOR_CACHE[key];
  if (!cached) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patterns = (cached as any).patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  const keywords = TOPIC_KEYWORDS[topic];
  if (!keywords) return null;
  let best = -1; let bestScore = 0;
  for (let i = 0; i < patterns.length; i++) {
    const what = ((patterns[i].what as string) ?? "").toLowerCase();
    if (!what) continue;
    let score = 0;
    for (const kw of keywords) if (what.includes(kw)) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return null;
  return ((patterns[best].what as string) ?? "").trim() || null;
}

export type RationaleInput = {
  topic: string;
  subTopicWeights?: Record<string, number>;
};

// Compose the rationale sentence. Returns null when we can't make a
// useful one (no sub-topics + no cached mistake) so the caller can
// fall back to the static combo.rationale.
export function deriveRationale(
  combo: RationaleInput,
  studentName: string,
  subject: "science",
  childFirst: string,
): string | null {
  const sortedSubs = combo.subTopicWeights
    ? Object.entries(combo.subTopicWeights).sort((a, b) => b[1] - a[1]).map(([id]) => humaniseSubTopic(id))
    : [];
  const topTwo = sortedSubs.slice(0, 2);
  const mistakeRaw = pickPatternForTopic(studentName, subject, combo.topic);
  if (topTwo.length === 0 && !mistakeRaw) return null;

  // Quote sub-topic names so a sub-topic that itself contains "and"
  // (e.g. "heat transfer and materials") stays distinguishable from
  // the conjunction joining the two sub-topics.
  const q = (s: string) => `“${s}”`;
  let out = "";
  if (topTwo.length === 0) {
    out = `This quiz drills the sub-topics where ${childFirst} seems weaker.`;
  } else if (topTwo.length === 1) {
    out = `This quiz will focus on the sub-topic of ${q(topTwo[0])}, where ${childFirst} seems weaker.`;
  } else {
    out = `This quiz will focus on sub-topics of ${q(topTwo[0])} and ${q(topTwo[1])}, where ${childFirst} seems weaker.`;
  }
  if (mistakeRaw) {
    out += ` I've also paired it with questions to address a pattern Lumi keeps seeing — ${childFirst} ${reframeMistake(mistakeRaw)}.`;
  }
  return out;
}
