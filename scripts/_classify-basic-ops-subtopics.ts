// Classify every P4/P5/P6/PSLE Basic-math-operations master MCQ into
// one of the four buckets the user approved (word problems dissolve
// into whichever bucket describes their core skill):
//   1. decimals-and-ordering
//   2. multiples-and-patterns
//   3. order-of-operations
//   4. rounding-and-estimation
//
// Batched calls to Gemini (~50 questions per batch) to amortise the
// per-call latency. Dry-run by default; --apply writes subTopic to DB.
// --reclass re-runs even rows that already have a subTopic (default
// skips them so re-runs are idempotent).
//
// Usage:
//   npx tsx scripts/_classify-basic-ops-subtopics.ts             # dry-run
//   npx tsx scripts/_classify-basic-ops-subtopics.ts --apply     # write
//   npx tsx scripts/_classify-basic-ops-subtopics.ts --apply --reclass

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const RECLASS = args.has("--reclass");

const BUCKETS = [
  { id: "decimals-and-ordering",   description: "Place value, comparing/ordering numbers (including decimals), fraction↔decimal conversion, digit-value questions." },
  { id: "multiples-and-patterns",  description: "Factors, multiples, common factors/multiples, prime numbers, number sequences and patterns." },
  { id: "order-of-operations",     description: "Direct arithmetic using +, −, ×, ÷ (including with remainders) and order-of-operations chains. Word problems whose core is a computation chain belong here." },
  { id: "rounding-and-estimation", description: "Rounding a number to a specified place; identifying possible values given rounding constraints; estimation." },
];
const BUCKET_IDS = new Set(BUCKETS.map(b => b.id));

const BATCH_SIZE = 50;

type Row = {
  id: string; questionNum: string; level: string | null;
  transcribedStem: string; transcribedOptions: string[]; answer: string; subTopic: string | null;
};

function stemPreview(q: Row, maxChars = 400): string {
  const opts = q.transcribedOptions.map((o, i) => `${i + 1}) ${o}`).join(" · ");
  const raw = `${q.transcribedStem} — Options: ${opts}${q.answer ? ` — Answer: ${q.answer}` : ""}`;
  return raw.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function classifyBatch(batch: Row[]): Promise<Map<string, string>> {
  const numbered = batch.map((q, i) => `[${i + 1}] (${(q.level ?? "?")} Q${q.questionNum}): ${stemPreview(q)}`).join("\n\n");
  const bucketBlock = BUCKETS.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const ids = BUCKETS.map(b => `"${b.id}"`).join(" | ");

  const prompt = `Classify each "Basic math operations" MCQ below into ONE of these four fixed sub-topics:

${bucketBlock}

Rules:
- Every question maps to exactly one bucket. Do NOT invent new buckets. Do NOT return "word problem" — a word problem folds into whichever of the four buckets describes its underlying maths.
- If multiple buckets could apply, pick the CORE skill the question tests.
- Return valid JSON only (no prose):

{
  "assignments": { "1": "bucket-id", "2": "bucket-id", ... }
}

Bucket IDs allowed: ${ids}

Questions:
${numbered}`;

  const resp = await generateContentWithRetry({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const raw = resp.text ?? "";
  let parsed: { assignments?: Record<string, string> } = {};
  try { parsed = JSON.parse(raw); } catch { /* handled below */ }
  const map = new Map<string, string>();
  const a = parsed.assignments ?? {};
  for (const [idxStr, bucket] of Object.entries(a)) {
    const idx = parseInt(idxStr, 10) - 1;
    if (idx < 0 || idx >= batch.length) continue;
    if (!BUCKET_IDS.has(bucket)) continue;
    map.set(batch[idx].id, bucket);
  }
  return map;
}

(async () => {
  const t0 = Date.now();
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { in: ["Basic math operations", "Basic Math Operations"] },
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "math", mode: "insensitive" },
        level: { in: ["Primary 4", "Primary 5", "Primary 6", "P6", "PSLE"] },
      },
    },
    select: {
      id: true, questionNum: true, subTopic: true,
      transcribedStem: true, transcribedOptions: true, answer: true,
      examPaper: { select: { level: true } },
    },
  });
  const eligible: Row[] = rows
    .filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2 && (r.transcribedStem ?? "").length > 15)
    .filter(r => RECLASS || !r.subTopic || !BUCKET_IDS.has(r.subTopic))
    .map(r => ({
      id: r.id, questionNum: r.questionNum, subTopic: r.subTopic,
      level: r.examPaper.level, transcribedStem: r.transcribedStem ?? "",
      transcribedOptions: Array.isArray(r.transcribedOptions) ? (r.transcribedOptions as string[]) : [],
      answer: r.answer ?? "",
    }));
  console.log(`Eligible master MCQs: ${eligible.length}  (mode: ${APPLY ? "APPLY" : "DRY-RUN"}${RECLASS ? " · RECLASS" : ""})`);
  if (eligible.length === 0) { await prisma.$disconnect(); return; }

  const perBucket = new Map<string, number>();
  for (const b of BUCKETS) perBucket.set(b.id, 0);
  let classified = 0;
  let written = 0;
  const misses: string[] = [];

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    console.log(`  batch ${i / BATCH_SIZE + 1}: classifying ${batch.length} …`);
    const bt0 = Date.now();
    const map = await classifyBatch(batch);
    const bdt = ((Date.now() - bt0) / 1000).toFixed(1);
    console.log(`    done in ${bdt}s (${map.size}/${batch.length} assigned)`);
    for (const q of batch) {
      const bucket = map.get(q.id);
      if (!bucket) { misses.push(`${q.level} Q${q.questionNum} (${q.id})`); continue; }
      perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
      classified++;
      if (APPLY) {
        await prisma.examQuestion.update({ where: { id: q.id }, data: { subTopic: bucket } });
        written++;
      }
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSummary (elapsed ${dt}s):`);
  for (const b of BUCKETS) console.log(`  ${b.id.padEnd(30)}  n=${(perBucket.get(b.id) ?? 0).toString().padStart(3)}`);
  console.log(`  classified ${classified}/${eligible.length}${APPLY ? ` · wrote ${written}` : ` · dry-run (nothing written)`}`);
  if (misses.length > 0) {
    console.log(`\nUnassigned (${misses.length}) — re-run --reclass or eyeball:`);
    for (const m of misses.slice(0, 20)) console.log(`  ${m}`);
    if (misses.length > 20) console.log(`  … +${misses.length - 20} more`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
