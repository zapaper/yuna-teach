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
import { generateContentWithRetry } from "@/lib/gemini";

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

  // Score each pattern against THIS topic's keywords AND against
  // every other topic's keywords. Two things we use:
  //   · topicScore[i]   how relevant pattern i is to this combo's topic
  //   · maxOtherScore[i] highest score this pattern hits on any OTHER
  //                     topic — used to label a pattern as cross-cutting
  //                     (it doesn't anchor to any single topic, so it
  //                     applies to every combo as a general trap)
  const topicScore: number[] = [];
  const maxAnyScore: number[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const what = ((patterns[i].what as string) ?? "").toLowerCase();
    let scoreHere = 0;
    let scoreElsewhere = 0;
    if (what) {
      for (const kw of keywords) if (what.includes(kw)) scoreHere++;
      for (const [otherTopic, otherKws] of Object.entries(TOPIC_KEYWORDS)) {
        if (otherTopic === topic) continue;
        let s = 0;
        for (const kw of otherKws) if (what.includes(kw)) s++;
        if (s > scoreElsewhere) scoreElsewhere = s;
      }
    }
    topicScore[i] = scoreHere;
    maxAnyScore[i] = Math.max(scoreHere, scoreElsewhere);
  }

  // Order: highest topic-scoring patterns first (these speak directly
  // to this combo's topic), then patterns that don't anchor to any
  // topic at all (kid-level cross-cutting traps like "jumps to outcome,
  // skips keywords" — apply everywhere, worth a closing reminder).
  const topicAnchored = patterns
    .map((_, i) => i)
    .filter(i => topicScore[i] > 0)
    .sort((a, b) => topicScore[b] - topicScore[a]);
  const crossCutting = patterns
    .map((_, i) => i)
    .filter(i => maxAnyScore[i] === 0 && ((patterns[i].what as string) ?? "").trim().length > 0);

  const orderedIdxs = [...topicAnchored, ...crossCutting];
  if (orderedIdxs.length === 0) return null;

  // Pull up to 3 bullets per pattern (most patterns split into 2-3
  // distinct confusions in the workshop output). Stop when the
  // combined list hits 6 — that's about the most a kid will actually
  // read before the first question.
  const MAX_BULLETS_TOTAL = 6;
  const MAX_BULLETS_PER_PATTERN = 3;
  const bullets: string[] = [];
  for (const i of orderedIdxs) {
    const p = patterns[i];
    const what = (p.what as string) ?? "";
    const advice = (p.advice as string) ?? "";
    const fragments = [what, advice].filter(s => s && s.trim().length > 0).join(" ");
    // Split a pattern's prose into bullets. Sentence boundaries (. ; :)
    // are the cleanest, but workshop patterns often pile up multiple
    // confusions in a single sentence joined by ", such as" / ", or" /
    // ", and" — so we also split on commas followed by those
    // connectors. This is what lets a pattern like
    //   "tangled up with heat concepts, such as thinking heat is only
    //    gained during a change of state, or mixing up conductors"
    // surface as three readable bullets instead of one long sentence.
    const candidates = fragments
      .split(/[;.:](?:\s+|$)|,\s+(?=(?:such as|including|like|or|and|but|e\.g\.)\b)/i)
      .map(s => s.replace(/^\s*(?:such as|including|like|or|and|but|e\.g\.,?)\s+/i, "").trim())
      .filter(s => s.length > 8);
    const take = candidates.length > 0 ? candidates.slice(0, MAX_BULLETS_PER_PATTERN) : [what.trim()].filter(Boolean);
    for (const b of take) {
      if (bullets.length >= MAX_BULLETS_TOTAL) break;
      bullets.push(b);
    }
    if (bullets.length >= MAX_BULLETS_TOTAL) break;
  }
  if (bullets.length === 0) return null;
  // Heading uses the topic short-name. Most topics' titles work
  // verbatim; trim the parenthetical for the long Forces ones.
  const heading = topic
    .replace(/\s*\([^)]*\)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { heading, watchOut: bullets };
}

// In-process cache so repeat calls to reframeAsAdvice with the same
// input don't re-hit Gemini. Server restart clears it; that's fine
// because the reframed result lives on paper.metadata.lumiPreamble
// after quiz creation and only THIS function needs to be fast.
const reframeCache = new Map<string, string>();

// Convert a workshop "what" bullet (mistake callout — "The student
// tends to forget X") into kid-facing advice ("Remember that X..."),
// using Gemini at quiz-creation time. Parallel-safe; if Gemini errors
// or returns something useless, returns the input unchanged.
export async function reframeAsAdvice(bullet: string): Promise<string> {
  const trimmed = bullet.trim();
  if (trimmed.length < 8) return trimmed;
  const cached = reframeCache.get(trimmed);
  if (cached) return cached;
  const prompt = `Reframe this Singapore Primary Science workshop note into a SHORT, friendly piece of advice the student can read just before a quiz.

Note: "${trimmed}"

Rules:
- DO NOT call out the mistake or use words like "you", "tends to", "often", "sometimes confuses", "the student".
- Frame as a tip: start with "Remember", "Watch out for", "Don't forget", "Make sure to", or similar.
- One short sentence (max ~25 words).
- Keep the scientific content, just flip the framing.
- Use the EXACT scientific vocabulary the PSLE answer keys use. NOT casual paraphrases.
  · "compressed" — NEVER "squashed"
  · "evaporates" — NEVER "dries up" or "disappears"
  · "transparent" / "translucent" / "opaque" — NEVER "see-through" or "glow-y"
  · "freezes" / "solidifies" — NEVER "becomes hard"
  · "boils" / "melts" / "condenses" — keep these words as-is
  · "luminous" is ONLY for objects that produce their own light (sun, fire, bulb). Do NOT use it for anything else.
- No quotation marks, no leading bullet character.

Example
  Input: "Tends to identify the obvious solid objects in a container but occasionally forgets that air (a gas) is also present in the empty spaces."
  Output: Remember that an "empty" container still holds air — air is a gas that takes up space and can be compressed.

Just give the rewritten sentence, no labels or quotes.`;
  try {
    const res = await generateContentWithRetry(
      { model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.2 } },
      1, 3000, "reframe-advice",
    );
    let out = (res.text ?? "").trim();
    // Defensive cleanup — strip wrapping quotes / leading bullet chars
    // / "Output:" labels Gemini sometimes prepends.
    out = out.replace(/^["'`]+|["'`]+$/g, "").replace(/^[-•*]\s+/, "").replace(/^output\s*:\s*/i, "").trim();
    if (out.length < 8 || /tends to|sometimes confuses|often jumps|the student/i.test(out)) {
      // Didn't reframe — fall back to original
      reframeCache.set(trimmed, trimmed);
      return trimmed;
    }
    reframeCache.set(trimmed, out);
    return out;
  } catch {
    reframeCache.set(trimmed, trimmed);
    return trimmed;
  }
}

// Reframe a whole DeepDivePreamble's watchOut list. Calls reframeAsAdvice
// in parallel for speed.
export async function reframePreamble(preamble: DeepDivePreamble): Promise<DeepDivePreamble> {
  const reframed = await Promise.all(preamble.watchOut.map(reframeAsAdvice));
  return { heading: preamble.heading, watchOut: reframed };
}
