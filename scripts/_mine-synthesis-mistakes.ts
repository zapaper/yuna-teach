// Mine real student mistakes on Synthesis & Transformation from
// marked exam papers. Group by pattern (existing sub-topic or one of
// the 4 new ones we're adding). Strip student/parent names from
// notes so the master class can quote the lessons without naming.

import { prisma } from "../src/lib/db";

const EXISTING_BUCKETS = ["concession", "cause", "condition", "reported-speech"] as const;
const NEW_BUCKETS = ["preference", "participle-having", "inclusion-correlative", "relative-clause"] as const;
type Bucket = typeof EXISTING_BUCKETS[number] | typeof NEW_BUCKETS[number];

function extractBolds(stem: string | null): string[] {
  if (!stem) return [];
  return [...stem.matchAll(/\*\*([^*]{1,80})\*\*/g)]
    .map(m => m[1].trim().toLowerCase().replace(/\s+/g, " "));
}

function classify(stem: string | null): Bucket | null {
  const bolds = extractBolds(stem);
  for (const kw of bolds) {
    if (/^although\b|^even though\b|^though\b|^despite\b|^in spite of\b|^no matter\b/.test(kw)) return "concession";
    if (/^because\b|^because of\b|^due to\b|^owing to\b|^on account of\b|^as a result of\b|^thanks to\b/.test(kw)) return "cause";
    if (/^if\b|^unless\b|^only if\b|^only when\b|^only with\b|^only after\b|^otherwise\b|^provided\b|^as long as\b/.test(kw)) return "condition";
    if (/asked|told|wanted to know|wondered|requested|enquired|inquired|said\b/.test(kw)) return "reported-speech";
    if (/would rather|^would prefer|^rather than|^prefer\b|preference|prefers\b/.test(kw)) return "preference";
    if (/^having\b|^not having\b/.test(kw)) return "participle-having";
    if (/^both\b|^neither\b|^either\b|^not only\b/.test(kw)) return "inclusion-correlative";
    if (/\bor\b/.test(kw) && kw.length < 8) return "inclusion-correlative";
    if (/^which\b|^who\b|^whom\b|^whose\b|^where\b|^that\b/.test(kw)) return "relative-clause";
  }
  if (stem && /\b(asked|told|requested|wanted to know|wondered|enquired|inquired)\b/i.test(stem)) return "reported-speech";
  return null;
}

// Strip likely student names. We don't have a name table, so use
// heuristics: capitalised first names at the start of a quoted speech
// or in "X said" / "X asked" patterns, and any name we detect.
// Also normalise common parent-references and pronoun fragments.
function depersonalise(text: string): string {
  // Specific common patterns first — "X said …", "X asked …"
  let t = text;
  // The marker quotes from the student's text. Replace any "<Capital>+ said/asked/told"
  t = t.replace(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)?\b(?= (?:said|asked|told|wrote|wanted|gave))/g, "the student");
  // Strip explicit dataset-mentioned names like "Cleo", "Sarah", "Mary" when in obvious-name context
  // (capitalised word inside quotes about answers)
  t = t.replace(/"[^"]{0,100}([A-Z][a-z]{2,})['s]/g, m => m.replace(/[A-Z][a-z]+['s]?/, "the student"));
  // Collapse double-spaces
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

async function main() {
  // Pull marked synthesis questions that lost marks. markingNotes
  // holds the marker's per-part rationale — the gold mine.
  // Source-paper (visible=true) rows are unmarked templates; the real
  // marker output lives on the student-attempt clones (visible=false
  // Daily Quiz papers etc.). Mine from all marked rows regardless.
  const qs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      marksAwarded: { not: null },
      markingNotes: { not: null },
    },
    select: {
      questionNum: true, transcribedStem: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true, studentAnswer: true, answer: true,
    },
  });

  // Only those where student lost marks (got less than full).
  const partial = qs.filter(q =>
    q.marksAwarded != null && q.marksAvailable != null &&
    Number(q.marksAwarded) < Number(q.marksAvailable),
  );
  console.log(`${qs.length} marked synthesis questions in visible papers; ${partial.length} had marks lost.\n`);

  const byBucket = new Map<string, Array<{
    stem: string; expected: string; student: string; notes: string;
    awarded: number; available: number;
  }>>();
  for (const q of partial) {
    const bucket = classify(q.transcribedStem) ?? "uncategorised";
    const arr = byBucket.get(bucket) ?? [];
    arr.push({
      stem: depersonalise((q.transcribedStem ?? "").slice(0, 180)),
      expected: depersonalise((q.answer ?? "").slice(0, 120)),
      student: depersonalise((q.studentAnswer ?? "").slice(0, 120)),
      notes: depersonalise(q.markingNotes ?? ""),
      awarded: Number(q.marksAwarded),
      available: Number(q.marksAvailable),
    });
    byBucket.set(bucket, arr);
  }

  for (const [bucket, items] of [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n============================================================`);
    console.log(`${bucket}  (${items.length} questions where marks lost)`);
    console.log(`============================================================`);
    // Show first 6 examples per bucket to give a flavour
    for (const it of items.slice(0, 6)) {
      console.log(`\n  -- ${it.awarded}/${it.available} marks`);
      console.log(`  STEM: ${it.stem.replace(/\n/g, " ⏎ ")}`);
      console.log(`  EXPECTED: ${it.expected.replace(/\n/g, " ⏎ ")}`);
      console.log(`  STUDENT:  ${it.student.replace(/\n/g, " ⏎ ")}`);
      console.log(`  NOTES:    ${it.notes.replace(/\n/g, " ⏎ ").slice(0, 220)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
