// Deep-dive on the synthesis questions that didn't fit the 4 existing
// sub-topics (concession/cause/condition/reported-speech). Cluster the
// MISC bucket into candidate new sub-topics so we can decide which
// patterns to extend the master class with vs. seed synthetic
// generation against.

import { prisma } from "../src/lib/db";

type ExistingBucket = "concession" | "cause" | "condition" | "reported-speech";

function extractBolds(stem: string | null): string[] {
  if (!stem) return [];
  return [...stem.matchAll(/\*\*([^*]{1,80})\*\*/g)]
    .map(m => m[1].trim().toLowerCase().replace(/\s+/g, " "))
    .filter(s => s.length > 0);
}

function existingBucket(kw: string): ExistingBucket | null {
  if (/^although\b|^even though\b|^though\b|^despite\b|^in spite of\b|^no matter\b/.test(kw)) return "concession";
  if (/^because\b|^because of\b|^due to\b|^owing to\b|^on account of\b|^as a result of\b|^thanks to\b/.test(kw)) return "cause";
  if (/^if\b|^unless\b|^only if\b|^only when\b|^only with\b|^only after\b|^otherwise\b|^provided\b|^as long as\b/.test(kw)) return "condition";
  if (/asked|told|wanted to know|wondered|requested|enquired|inquired|said\b/.test(kw)) return "reported-speech";
  return null;
}

function isInExistingBucket(stem: string | null): boolean {
  const bolds = extractBolds(stem);
  for (const b of bolds) if (existingBucket(b)) return true;
  if (stem && /\b(asked|told|requested|wanted to know|wondered|enquired|inquired)\b/i.test(stem)) return true;
  return false;
}

// Candidate sub-topics for the misc bucket. Ordered: first match wins.
type CandidateBucket =
  | "participle-having"     // Having + V-ed (perfect participle joining)
  | "participle-ing"        // Seeing / Hearing / Feeling + clause
  | "preference-would-rather" // Would rather / prefer / preference / rather than
  | "relative-clause"       // which / who / whom / whose / where / that (defining clause)
  | "inclusion-correlative" // both…and / either…or / neither…nor / not only…but also
  | "exclusion-except"      // except / except for / apart from / other than
  | "gerund-instead-of"     // instead of + V-ing
  | "structure-much-to"     // much to (someone's) + noun
  | "structure-no-other"    // no other / nothing else / nobody else (superlative substitution)
  | "inversion-no-sooner"   // no sooner / hardly / scarcely + inversion
  | "inversion-little-only" // little did / only after / not until + inversion
  | "time-while-after"      // while / after / before / since (temporal)
  | "unbucketed";

function candidateBucket(kw: string, stem: string): CandidateBucket {
  // PARTICIPLE
  if (/^having\b|^not having\b/.test(kw)) return "participle-having";
  if (/^seeing\b|^hearing\b|^feeling\b|^realising\b|^noticing\b/.test(kw)) return "participle-ing";
  // PREFERENCE
  if (/would rather|^would prefer|^rather than|^prefer\b|preference/.test(kw)) return "preference-would-rather";
  if (/prefers\b/.test(kw)) return "preference-would-rather";
  // RELATIVE
  if (/^which\b|^who\b|^whom\b|^whose\b|^where\b|^that\b/.test(kw)) return "relative-clause";
  // INCLUSION (correlative pairs)
  if (/^both\b|^neither\b|^either\b|^not only\b/.test(kw)) return "inclusion-correlative";
  if (/\bor\b/.test(kw) && kw.length < 8) return "inclusion-correlative";
  // EXCLUSION
  if (/^except\b|^apart from\b|^other than\b/.test(kw)) return "exclusion-except";
  // GERUND
  if (/^instead of\b/.test(kw)) return "gerund-instead-of";
  // STRUCTURE
  if (/^much to\b/.test(kw)) return "structure-much-to";
  if (/^no other\b|nothing else|nobody else/.test(kw)) return "structure-no-other";
  // INVERSION
  if (/^no sooner\b|^hardly\b|^scarcely\b/.test(kw)) return "inversion-no-sooner";
  if (/^little did\b|^only after\b|^not until\b|^never\b|^seldom\b/.test(kw)) return "inversion-little-only";
  // TIME
  if (/^while\b|^after\b|^before\b|^since\b/.test(kw)) return "time-while-after";

  // Fallback signals from the source sentence text
  if (/\bwould rather\b|prefers?\b/i.test(stem)) return "preference-would-rather";
  if (/\bno sooner\b|\bhardly\b|\bscarcely\b/i.test(stem)) return "inversion-no-sooner";
  return "unbucketed";
}

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      examPaper: { visible: true },
    },
    select: {
      id: true, transcribedStem: true,
      examPaper: { select: { level: true } },
    },
  });

  const misc = qs.filter(q => !isInExistingBucket(q.transcribedStem));
  console.log(`Misc bucket: ${misc.length} questions (of ${qs.length} total)\n`);

  const buckets = new Map<CandidateBucket, { count: number; samples: { stem: string; bolds: string[] }[] }>();
  for (const q of misc) {
    const bolds = extractBolds(q.transcribedStem);
    // Try each bold; first non-unbucketed wins.
    let chosen: CandidateBucket = "unbucketed";
    for (const b of bolds) {
      const c = candidateBucket(b, q.transcribedStem ?? "");
      if (c !== "unbucketed") { chosen = c; break; }
    }
    if (chosen === "unbucketed") {
      // Last resort: stem-level scan with any bold as anchor
      chosen = candidateBucket("", q.transcribedStem ?? "");
    }
    const b = buckets.get(chosen) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 3) {
      b.samples.push({ stem: (q.transcribedStem ?? "").slice(0, 160), bolds });
    }
    buckets.set(chosen, b);
  }

  for (const [name, b] of [...buckets.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${b.count.toString().padStart(4)}  ${name}`);
    for (const s of b.samples) {
      console.log(`        ${s.stem.replace(/\n/g, " ⏎ ")}`);
      console.log(`          bolds: [${s.bolds.join(" | ")}]`);
    }
    console.log();
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
