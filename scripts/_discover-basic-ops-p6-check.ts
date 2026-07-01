// P6 alignment check for the 4-bucket Basic-ops taxonomy proposed by
// the user (word problems dissolve into whichever of the 4 they touch):
//
//   1. decimals-and-ordering       — place value, comparing/ordering,
//                                     decimals, fraction/decimal conversion
//   2. multiples-and-patterns       — factors, multiples, common
//                                     factors/multiples, number sequences
//   3. order-of-operations          — direct computation using the four
//                                     operations, order of operations,
//                                     remainders
//   4. rounding-and-estimation      — round to place, "possible values"
//
// Sample 60 P6 Basic-ops master MCQs and ask Gemini to assign each to
// exactly one of these four (word problems fold into whichever their
// core operation belongs to).
//
// Run:
//   npx tsx scripts/_discover-basic-ops-p6-check.ts

import "dotenv/config";
import { writeFile } from "fs/promises";
import path from "path";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

const BUCKETS = [
  { id: "decimals-and-ordering",  description: "Place value, comparing/ordering numbers (including decimals), fraction↔decimal conversion, digit-value questions." },
  { id: "multiples-and-patterns", description: "Factors, multiples, common factors/multiples, prime numbers, number sequences and patterns." },
  { id: "order-of-operations",    description: "Direct arithmetic using +, −, ×, ÷ (including with remainders) and order-of-operations chains. Assign a word problem here if its core is a computation chain." },
  { id: "rounding-and-estimation", description: "Rounding a number to a specified place; identifying possible values given rounding constraints; estimation." },
];

type Q = { id: string; questionNum: string; transcribedStem: string; transcribedOptions: string[]; answer: string };

function stemPreview(q: Q, maxChars = 400): string {
  const opts = q.transcribedOptions.map((o, i) => `${i + 1}) ${o}`).join(" · ");
  const raw = `${q.transcribedStem} — Options: ${opts}${q.answer ? ` — Answer: ${q.answer}` : ""}`;
  return raw.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

(async () => {
  console.log(`Sampling P6 Basic-ops master MCQs …`);
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { in: ["Basic math operations", "Basic Math Operations"] },
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "math", mode: "insensitive" },
        level: { in: ["Primary 6", "P6", "PSLE"] },
      },
    },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      transcribedOptions: true, answer: true,
      examPaper: { select: { level: true } },
    },
  });
  const mcq = rows.filter(r =>
    Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2 &&
    (r.transcribedStem ?? "").length > 20,
  );
  mcq.sort((a, b) => a.id.localeCompare(b.id));
  const picked = mcq.slice(0, 60);
  console.log(`  P6/PSLE picked: ${picked.length} of ${mcq.length} eligible`);

  const sample: Q[] = picked.map(r => ({
    id: r.id, questionNum: r.questionNum,
    transcribedStem: r.transcribedStem ?? "",
    transcribedOptions: Array.isArray(r.transcribedOptions) ? (r.transcribedOptions as string[]) : [],
    answer: r.answer ?? "",
  }));
  const numbered = sample.map((q, i) => `[${i + 1}] Q${q.questionNum}: ${stemPreview(q)}`).join("\n\n");

  const bucketBlock = BUCKETS.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const ids = BUCKETS.map(b => `"${b.id}"`).join(" | ");

  const prompt = `Classify each P6 "Basic math operations" MCQ below into ONE of these four fixed sub-topics:

${bucketBlock}

Rules:
- Every question MUST map to exactly one bucket. Do NOT invent new buckets. Do NOT return "word problem" — a word problem folds into whichever bucket describes its underlying maths (e.g. "Uncle Tan bought decimals of…" → decimals-and-ordering; "the smallest number that is divisible by 3 and 4" → multiples-and-patterns; "estimate 4823 × 19" → rounding-and-estimation; "5 + 4 × 3 − 2" → order-of-operations).
- If multiple could apply, pick the bucket that captures the CORE skill the question tests.
- Return valid JSON only:

{
  "assignments": { "1": "bucket-id", "2": "bucket-id", ... },
  "confidence": { "1": "high|medium|low", ... },
  "notes": { "1": "one-line rationale for medium/low picks" }
}

Bucket IDs allowed: ${ids}

Questions:
${numbered}`;

  console.log(`\nCalling Gemini (prompt = ${prompt.length} chars) …`);
  const t0 = Date.now();
  const resp = await generateContentWithRetry({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const raw = resp.text ?? "";
  console.log(`  done in ${dt}s (${raw.length} chars)`);

  let parsed: { assignments: Record<string, string>; confidence?: Record<string, string>; notes?: Record<string, string> } | null = null;
  try { parsed = JSON.parse(raw); } catch (e) { console.error(`JSON parse fail: ${(e as Error).message}`); }

  const out = {
    generatedAt: new Date().toISOString(),
    sampleSize: sample.length,
    buckets: BUCKETS,
    indexToQuestionId: Object.fromEntries(sample.map((q, i) => [i + 1, { id: q.id, qNum: q.questionNum, stemPreview: stemPreview(q, 160) }])),
    geminiRaw: raw,
    geminiParsed: parsed,
  };
  const outPath = path.join(__dirname, "..", "eval", "basic-ops-p6-check.json");
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${outPath}`);

  if (parsed) {
    const counts = new Map<string, number>();
    const lowConf: string[] = [];
    for (const b of BUCKETS) counts.set(b.id, 0);
    for (const [idx, bucket] of Object.entries(parsed.assignments)) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      const c = parsed.confidence?.[idx];
      if (c === "low" || c === "medium") {
        const q = sample[parseInt(idx, 10) - 1];
        lowConf.push(`  [${idx}] Q${q.questionNum} (${c}) → ${bucket}  · ${parsed.notes?.[idx] ?? ""}`);
      }
    }
    console.log(`\nP6 distribution across the 4 fixed buckets:`);
    for (const b of BUCKETS) {
      const n = counts.get(b.id) ?? 0;
      console.log(`  ${b.id.padEnd(30)}  n=${n.toString().padStart(3)}`);
    }
    if (lowConf.length > 0) {
      console.log(`\nGemini flagged ${lowConf.length} questions as low/medium-confidence:`);
      for (const line of lowConf.slice(0, 15)) console.log(line);
      if (lowConf.length > 15) console.log(`  … +${lowConf.length - 15} more`);
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
