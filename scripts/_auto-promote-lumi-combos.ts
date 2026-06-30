// Auto-promote Lumi combos from workshop JSON cache + DB weak-topic
// computation. Generates a `.generated.ts` file that lumi-combos.ts
// extends — so the static map stays small but every kid with a
// workshop cache gets 2 personalised combos derived from their actual
// pattern signal.
//
// Pipeline per kid+subject:
//   1. Read unified-diagnosis-<kid>-<subject>.gemini-cache.json
//   2. Query DB for the kid's 2 weakest pickable topics (Science:
//      any topic; English: only Grammar MCQ / Vocab MCQ / Synthesis
//      since the rest are section-bound)
//   3. For each weak topic, match the best cache pattern via keyword
//      scoring (reuses the TOPIC_KEYWORDS map from lumi-deepdive.ts)
//   4. Emit a LumiQuizCombo / LumiEnglishQuizCombo entry with:
//      · label = `${topic} — focused practice`
//      · rationale = derived from miss-rate + workshop pattern name
//      · subTopicWeights = top weak sub-topics within the topic
//      · skillTag = "evidence-then-conclusion" (default for Science)
//      · topicRecap.watchOut = matched pattern's strategic_advice +
//        the first 2-3 whatWentWrong bullets, reformatted for kids
//   5. Write src/lib/lumi-combos.auto.generated.ts
//
// Re-run this after any workshop refresh.

import { prisma } from "@/lib/db";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CACHE_DIR = "src/lib/tutor-cache";
const OUT_PATH = "src/lib/lumi-combos.auto.generated.ts";

// Pickable English topics (everything else is section-bound; see
// lumi-combos.ts for the rationale).
const ENGLISH_PICKABLE = new Set(["Grammar MCQ", "Vocabulary MCQ", "Synthesis / Transformation"]);

// Map a kid-slug → DB userId. Built once at the start of the run.
async function buildSlugToUserId(): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true },
  });
  const out = new Map<string, string>();
  for (const u of users) {
    if (!u.name) continue;
    // Slugify: lowercase, replace non-alnum with hyphen, collapse
    const slug = u.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) out.set(slug, u.id);
    // Also handle "first-only" (workshop tends to slug "David lim" → "david-lim" OR just "david")
    const first = slug.split("-")[0];
    if (first && !out.has(first)) out.set(first, u.id);
  }
  return out;
}

type CachePattern = {
  name: string;
  what: string;
  specific_examples?: Array<{ questionRef: string; type?: string; whatWentWrong?: string }>;
  strategic_advice?: string;
  trigger_keywords?: string[];
};
type Cache = {
  patterns?: CachePattern[];
  toplineSnapshot?: { avgPct?: number; totalAvailable?: number };
};

function readCache(path: string): Cache | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cache;
  } catch {
    return null;
  }
}

async function weakTopicsForKid(userId: string, subject: string): Promise<Array<{ topic: string; pct: number; missed: number; seen: number; subBreakdown: Map<string, { missed: number; seen: number }> }>> {
  // Match the student-progress endpoint filter exactly:
  //   - exclude eval paperType (regression test clones)
  //   - exclude papers with metadata.revisionMode (curated past-mistake
  //     re-attempts that would double-count those mistakes and
  //     artificially drop weak-topic scores)
  // Without these filters, a kid like Kaiyang shows Grammar MCQ 65%
  // (inflated by revision clones repeating the same wrongs) while the
  // dashboard chart shows Grammar MCQ 87% — and the picker would
  // mistakenly target Grammar over actually-weaker topics.
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: userId,
        subject: { contains: subject, mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
      marksAwarded: { not: null }, marksAvailable: { not: null, gt: 0 },
    },
    select: { syllabusTopic: true, subTopic: true, marksAwarded: true, marksAvailable: true, examPaper: { select: { metadata: true } } },
  });
  // Drop revision-mode papers (filter in JS — metadata is JSON)
  const filtered = rows.filter(r => {
    const meta = (r.examPaper.metadata ?? {}) as { revisionMode?: string };
    return !meta.revisionMode;
  });
  const byTopic = new Map<string, { seen: number; missed: number; subs: Map<string, { seen: number; missed: number }> }>();
  for (const r of filtered) {
    const t = r.syllabusTopic ?? "(no topic)";
    if (!t || t === "(no topic)") continue;
    const b = byTopic.get(t) ?? { seen: 0, missed: 0, subs: new Map() };
    b.seen++;
    const missed = (r.marksAwarded ?? 0) < (r.marksAvailable ?? 0);
    if (missed) b.missed++;
    const sub = r.subTopic ?? "(untagged)";
    const sb = b.subs.get(sub) ?? { seen: 0, missed: 0 };
    sb.seen++;
    if (missed) sb.missed++;
    b.subs.set(sub, sb);
    byTopic.set(t, b);
  }
  return [...byTopic.entries()]
    .filter(([, b]) => b.seen >= 5)  // gate: need ≥5 attempts for a real signal
    .map(([t, b]) => ({
      topic: t,
      pct: Math.round(b.missed / b.seen * 100),
      missed: b.missed,
      seen: b.seen,
      subBreakdown: b.subs,
    }))
    .sort((a, b) => (b.missed / (b.seen + 3)) - (a.missed / (a.seen + 3)));
}

// Match a topic against the cache's patterns by keyword overlap.
// Same shape as lumi-deepdive.ts but inline so the script stays self-
// contained.
const TOPIC_KEYWORDS: Record<string, string[]> = {
  // Science
  "Heat energy and uses": ["heat", "conductor", "insulator", "temperature", "evaporation", "evaporates", "state change", "melt", "boil"],
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)": ["force", "forces", "friction", "gravity", "gravitational", "elastic", "spring", "weight"],
  "Energy conversion": ["energy convert", "energy conversion", "kinetic", "potential", "energy form", "energy is lost"],
  "Interaction of forces (Magnets)": ["magnet", "magnetic", "pole", "attraction", "repulsion"],
  "Reproduction in plants and animals": ["reproduction", "reproductive", "pollination", "fertilisation", "fertilization", "ovule", "anther", "stigma", "sperm", "ovary"],
  "Life cycles in plants and animals": ["life cycle", "germination", "larva", "pupa", "tadpole", "egg to adult"],
  "Photosynthesis": ["photosynthesis", "photosynthesise", "chlorophyll", "chloroplast"],
  "Light energy and uses": ["light", "shadow", "shadows", "reflection", "reflect", "transparent", "translucent", "opaque"],
  "Electrical system and circuits": ["circuit", "bulb", "battery", "switch", "series", "parallel", "current", "electromagnet"],
  "Human respiratory and circulatory systems": ["heart rate", "breathing rate", "lungs", "respiratory", "circulatory", "blood", "alveoli", "exercise"],
  "Plant respiratory and circulatory systems": ["xylem", "phloem", "transpiration", "stomata", "respiration"],
  "Water cycle, evaporation, condensation": ["water cycle", "evaporation", "condensation", "precipitation", "mist", "fog"],
  "Plant parts and functions": ["xylem", "phloem", "stomata", "transpiration", "root", "leaf", "stem"],
  "Cycles in matter": ["solid", "liquid", "gas", "matter", "volume", "displacement"],
  "Diversity of living and non-living things": ["classification", "vertebrate", "invertebrate", "fungi", "bacteria", "mammal", "reptile"],
  "Interactions within the environment": ["food chain", "food web", "producer", "consumer", "decomposer", "habitat", "ecosystem", "predator"],
  "Human digestive system": ["digestion", "digestive", "stomach", "intestine", "enzyme", "absorption"],
  // English
  "Grammar MCQ": ["grammar", "pronoun", "tag question", "subject-verb", "preposition"],
  "Vocabulary MCQ": ["vocabulary", "word meaning", "synonym", "context clue"],
  "Synthesis / Transformation": ["synthesis", "reported speech", "passive", "relative clause", "transformation", "combining sentences"],
};

function matchPattern(topic: string, patterns: CachePattern[]): CachePattern | null {
  const topicKws = (TOPIC_KEYWORDS[topic] ?? topic.toLowerCase().split(/\s+/)).map(s => s.toLowerCase());
  let bestScore = 0;
  let best: CachePattern | null = null;
  for (const p of patterns) {
    const haystack = [p.name, p.what, ...(p.trigger_keywords ?? []), ...(p.specific_examples ?? []).map(e => e.whatWentWrong ?? "")].join(" ").toLowerCase();
    let score = 0;
    for (const kw of topicKws) if (haystack.includes(kw)) score++;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore > 0 ? best : null;
}

function watchOutFromPattern(p: CachePattern): string[] {
  const out: string[] = [];
  if (p.strategic_advice) out.push(p.strategic_advice);
  for (const e of (p.specific_examples ?? []).slice(0, 2)) {
    if (e.whatWentWrong) out.push(e.whatWentWrong);
  }
  return out;
}

function topicLabel(topic: string): string {
  // Friendly label — strip parentheticals + truncate
  return topic.replace(/\s*\([^)]+\)/g, "").trim();
}

function topSubWeights(subBreakdown: Map<string, { seen: number; missed: number }>, totalCount: number): Record<string, number> {
  // Pick top-3 weakest sub-topics by missed count, normalize so weights sum to totalCount
  const entries = [...subBreakdown.entries()]
    .filter(([k]) => k !== "(untagged)")
    .map(([k, b]) => ({ k, seen: b.seen, missed: b.missed }))
    .filter(b => b.missed > 0)
    .sort((a, b) => b.missed - a.missed)
    .slice(0, 3);
  if (entries.length === 0) return {};
  const totalMissed = entries.reduce((s, e) => s + e.missed, 0);
  const out: Record<string, number> = {};
  for (const e of entries) out[e.k] = Math.max(1, Math.round(e.missed / totalMissed * totalCount));
  return out;
}

type GenComboScience = {
  studentId: string;
  studentName: string;
  combos: Array<{ topic: string; pct: number; missed: number; seen: number; pattern: CachePattern | null; subWeights: Record<string, number> }>;
};
type GenComboEnglish = GenComboScience;

async function main() {
  const slugMap = await buildSlugToUserId();
  const files = readdirSync(CACHE_DIR).filter(f => /^unified-diagnosis-.+-(science|english)\.gemini-cache\.json$/.test(f));
  console.log(`Found ${files.length} cache files\n`);

  const scienceGen: GenComboScience[] = [];
  const englishGen: GenComboEnglish[] = [];
  const skipped: string[] = [];

  for (const f of files) {
    const m = f.match(/^unified-diagnosis-(.+)-(science|english)\.gemini-cache\.json$/);
    if (!m) continue;
    const slug = m[1];
    const subject = m[2];
    const cache = readCache(join(CACHE_DIR, f));
    if (!cache?.patterns?.length) { skipped.push(`${slug}/${subject}: no patterns`); continue; }
    const userId = slugMap.get(slug);
    if (!userId) { skipped.push(`${slug}/${subject}: no DB user match`); continue; }

    const allWeakTopics = await weakTopicsForKid(userId, subject === "science" ? "Science" : "English");
    const weak = subject === "english"
      ? allWeakTopics.filter(t => ENGLISH_PICKABLE.has(t.topic))
      : allWeakTopics;
    if (weak.length < 2) { skipped.push(`${slug}/${subject}: only ${weak.length} pickable weak topic(s)`); continue; }

    // For English: prefer Grammar MCQ + Synthesis (both have sub-topic
    // targeting + workshop-pattern coverage). Vocab MCQ is technically
    // pickable but has no sub-topic classifier, so the auto-generated
    // combo for it carries no targeting beyond the topic name — drill
    // is shallower. Only fall back to Vocab MCQ when neither of the
    // two preferred topics is a real weakness (miss rate >= 15%).
    let top2: typeof weak;
    if (subject === "english") {
      const PREFERRED = new Set(["Grammar MCQ", "Synthesis / Transformation"]);
      const preferred = weak.filter(t => PREFERRED.has(t.topic) && t.pct >= 15);
      const others = weak.filter(t => !PREFERRED.has(t.topic) || t.pct < 15);
      // Take from preferred first, top up from others. Limit 2.
      top2 = [...preferred, ...others].slice(0, 2);
    } else {
      top2 = weak.slice(0, 2);
    }
    const combos = top2.map(t => ({
      topic: t.topic,
      pct: t.pct,
      missed: t.missed,
      seen: t.seen,
      pattern: matchPattern(t.topic, cache.patterns!),
      subWeights: topSubWeights(t.subBreakdown, subject === "english" && t.topic === "Synthesis / Transformation" ? 6 : 10),
    }));
    const studentName = [...slugMap.entries()].find(([, id]) => id === userId)?.[0] ?? slug;
    if (subject === "science") scienceGen.push({ studentId: userId, studentName: studentName, combos });
    else englishGen.push({ studentId: userId, studentName: studentName, combos });
  }

  console.log(`Generated: ${scienceGen.length} Science + ${englishGen.length} English combos`);
  console.log(`Skipped: ${skipped.length} cache files\n`);
  if (skipped.length > 0 && skipped.length < 30) {
    console.log("Skipped reasons:");
    for (const s of skipped) console.log(`  ${s}`);
  }

  // ─── Write the generated file ───────────────────────────────────────
  const header = `// AUTO-GENERATED — do not edit by hand.
// Run: npx tsx scripts/_auto-promote-lumi-combos.ts
// Reads workshop cache (src/lib/tutor-cache/) + DB to build a combo
// per kid+subject for every kid with both a workshop diagnosis AND
// ≥2 pickable weak topics (≥5 attempts each).
//
// Used as a fallback by lumi-combos.ts when no hand-written entry
// exists.

import type { LumiQuizCombo, LumiEnglishQuizCombo } from "./lumi-combos";

`;

  // Build a friendly label that includes top sub-topics where the
  // picker will bias the quiz. Falls back to plain topic name when no
  // sub-topics are weighted (the kid's clones don't have sub-topic
  // tags). Drops the misleading "— focused practice" suffix the
  // previous version used: the button container already says
  // "Personalised quiz" and adding "focused practice" made parents
  // mistake the personalised button for the generic amber CTA.
  function comboLabel(c: { topic: string; subWeights: Record<string, number> }): string {
    const topName = topicLabel(c.topic);
    const subs = Object.entries(c.subWeights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    return subs.length > 0 ? `${topName} — ${subs.join(", ")}` : topName;
  }

  const sciExport = `export const AUTO_LUMI_COMBOS_SCIENCE: Record<string, LumiQuizCombo[]> = {\n` +
    scienceGen.map(g => `  // ${g.studentName}\n  "${g.studentId}": [\n${g.combos.map(c => `    {\n      label: ${JSON.stringify(comboLabel(c))},\n      rationale: ${JSON.stringify(`Top miss area (${c.missed}/${c.seen} = ${c.pct}%). Drilled where your sub-topic gaps are biggest.`)},\n      topic: ${JSON.stringify(c.topic)},\n      subTopicWeights: ${JSON.stringify(c.subWeights)},\n      skillTag: "evidence-then-conclusion",\n      topicRecap: {\n        heading: ${JSON.stringify(`${topicLabel(c.topic)} — what to look out for`)},\n        watchOut: ${JSON.stringify(c.pattern ? watchOutFromPattern(c.pattern) : [], null, 8).split("\n").map(l => "        " + l.trim()).join("\n").trim()},\n      },\n    },`).join("\n")}\n  ],`).join("\n") + "\n};\n\n";

  const engExport = `export const AUTO_LUMI_COMBOS_ENGLISH: Record<string, LumiEnglishQuizCombo[]> = {\n` +
    englishGen.map(g => `  // ${g.studentName}\n  "${g.studentId}": [\n${g.combos.map(c => `    {\n      label: ${JSON.stringify(comboLabel(c))},\n      rationale: ${JSON.stringify(`Top miss area (${c.missed}/${c.seen} = ${c.pct}%). Drilled where your sub-topic gaps are biggest.`)},\n      topic: ${JSON.stringify(c.topic)} as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",\n      subTopicWeights: ${JSON.stringify(c.subWeights)},\n      count: ${c.topic === "Synthesis / Transformation" ? 6 : 10},\n      topicRecap: {\n        heading: ${JSON.stringify(`${topicLabel(c.topic)} — what to look out for`)},\n        watchOut: ${JSON.stringify(c.pattern ? watchOutFromPattern(c.pattern) : [], null, 8).split("\n").map(l => "        " + l.trim()).join("\n").trim()},\n      },\n    },`).join("\n")}\n  ],`).join("\n") + "\n};\n";

  writeFileSync(OUT_PATH, header + sciExport + engExport, "utf8");
  console.log(`\nWrote ${OUT_PATH}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
