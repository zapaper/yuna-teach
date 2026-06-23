// Data-driven sub-topic bucket derivation. For one topic:
//   1. Pull up to 50 OEQ master questions across P5+P6+PSLE.
//   2. Ask Gemini to read all stems+answers and emit a bucket list
//      (3-5 buckets) that captures the natural themes.
//   3. Classify each of the 50 against the derived buckets.
//   4. Print distribution + any "other" misfires for review.
//
// Usage:
//   npx tsx scripts/derive-subtopic-buckets.ts --topic="Heat energy and uses"
//
// Output: eval/derived-buckets/<topic-slug>.json

import { promises as fs } from "fs";
import path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";
import { prisma } from "../src/lib/db";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--(\w+)=(.+)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
) as { topic?: string; limit?: string };

const TOPIC = args.topic;
if (!TOPIC) { console.error("--topic= required"); process.exit(1); }
const LIMIT = args.limit ? parseInt(args.limit) : 50;

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

type Q = {
  id: string;
  questionNum: string;
  marksAvailable: number | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  answer: string | null;
  examPaper: { title: string; level: string | null };
};

// Format the question content the classifier sees. For MCQs, the
// distinguishing detail often lives in the option list, not the stem
// ("Which of the following is a conductor? 1) wood 2) copper ..."),
// so we fold options into the prompt when present.
function questionText(q: Q): string {
  const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim();
  const opts = q.transcribedOptions;
  let optBlock = "";
  if (Array.isArray(opts) && opts.length > 0) {
    const lines = opts.map((o, i) => {
      const text = typeof o === "string" ? o : (o && typeof o === "object" && "text" in o ? String((o as { text: unknown }).text) : "");
      return `${i + 1}) ${text}`;
    }).filter(l => l.trim().length > 3);
    if (lines.length > 0) optBlock = `\nOptions:\n${lines.join("\n")}`;
  }
  return (stem || "(diagram-only stem)") + optBlock;
}

function summariseQ(q: Q, idx: number): string {
  const ans = (q.answer ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `[${idx}] (${q.marksAvailable}m, ${q.examPaper.level}) Q${q.questionNum}\n${questionText(q).slice(0, 400)}\nanswer: ${ans || "(no key)"}`;
}

async function deriveBuckets(qs: Q[]): Promise<{ buckets: { id: string; description: string }[] }> {
  const block = qs.map(summariseQ).join("\n---\n");
  const prompt = `You are reading ${qs.length} Primary 5/6 Singapore Science exam questions all under the syllabus topic "${TOPIC}".
Your job: propose a sub-topic taxonomy of 3 to 5 buckets that captures the NATURAL clusters in what these questions are actually testing.

QUESTIONS:
${block}

Rules:
- Bucket count: 3, 4, or 5. Default to 4. Only go to 3 if the data really is that uniform; only to 5 if there's a clear fifth cluster of 8+ questions.
- Each bucket should plausibly hold 8+ of the sampled questions. If a candidate bucket would have <5 questions, merge it into a sibling.
- Bucket IDs: kebab-case, 2-4 words. E.g. "conductors-insulators", "exercise-and-response".
- Bucket descriptions: one sentence, concrete enough to classify against.

Respond with strict JSON:
{ "buckets": [ { "id": "...", "description": "..." }, ... ] }`;

  const res = await generateContentWithRetry(
    { model: "gemini-2.5-pro", contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } },
    1, 5000, `derive:${slug(TOPIC!).slice(0, 20)}`,
  );
  const text = res.text ?? "";
  const j = JSON.parse(text);
  return { buckets: j.buckets ?? [] };
}

async function classifyOne(q: Q, buckets: { id: string; description: string }[]): Promise<{ subTopic: string; reason: string } | null> {
  const block = buckets.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const ids = buckets.map(b => `"${b.id}"`).join(", ");
  const ans = (q.answer ?? "").trim();
  const prompt = `Topic: ${TOPIC}. Pick the SINGLE sub-topic that best fits.

Buckets:
${block}

QUESTION (${q.marksAvailable} marks):
${questionText(q)}

ANSWER KEY:
${ans || "(none)"}

If genuinely none fit, return "other".

JSON: { "subTopic": "...", "reason": "one short sentence" }
subTopic must be one of: ${ids}, "other".`;
  try {
    const res = await generateContentWithRetry(
      { model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } },
      1, 3000, `classify:${q.id.slice(-6)}`,
    );
    const j = JSON.parse(res.text ?? "");
    return { subTopic: j.subTopic ?? "other", reason: j.reason ?? "" };
  } catch {
    return null;
  }
}

(async () => {
  const fetched = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
        level: { in: ["P5", "Primary 5", "5", "P6", "Primary 6", "6", "PSLE"] },
      },
      syllabusTopic: TOPIC,
    },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, answer: true,
      examPaper: { select: { title: true, level: true } },
    },
  });
  // Include MCQs in addition to OEQs — for thin-pool topics the MCQ
  // options often carry the distinguishing detail (which is also what
  // a student actually answers). Only require some text content to
  // exist (stem OR options OR answer) so the classifier has something
  // to work with.
  const oeqs = fetched.filter(q => {
    const hasStem = (q.transcribedStem ?? "").trim().length > 0;
    const hasAnswer = (q.answer ?? "").trim().length > 0;
    const opts = q.transcribedOptions;
    const hasOptions = Array.isArray(opts) && opts.length > 0;
    return hasStem || hasAnswer || hasOptions;
  });
  // Shuffle + take LIMIT
  for (let i = oeqs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [oeqs[i], oeqs[j]] = [oeqs[j], oeqs[i]];
  }
  const sample = oeqs.slice(0, LIMIT);
  console.log(`Topic: ${TOPIC}`);
  console.log(`OEQ pool size: ${oeqs.length}, sampling ${sample.length}\n`);

  console.log("Step 1: deriving bucket taxonomy from sample…");
  const { buckets } = await deriveBuckets(sample);
  console.log(`Derived ${buckets.length} buckets:`);
  for (const b of buckets) console.log(`  - ${b.id}: ${b.description}`);

  console.log("\nStep 2: classifying sample against derived buckets…");
  const counts: Record<string, number> = { other: 0 };
  for (const b of buckets) counts[b.id] = 0;
  const otherRows: { q: Q; reason: string }[] = [];
  const tooThin: { q: Q; reason: string; bucket: string }[] = [];
  let i = 0;
  for (const q of sample) {
    i++;
    const v = await classifyOne(q, buckets);
    const st = v?.subTopic ?? "(no-resp)";
    counts[st] = (counts[st] ?? 0) + 1;
    if (st === "other") otherRows.push({ q, reason: v?.reason ?? "" });
    process.stdout.write(`  [${i}/${sample.length}] ${st.padEnd(30)} Q${q.questionNum}\n`);
  }

  console.log("\n=== Distribution ===");
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const flag = n < 5 ? "  ⚠ thin" : n > sample.length * 0.5 ? "  ⚠ over-represented" : "";
    console.log(`  ${String(n).padStart(3)}  ${k}${flag}`);
  }
  if (otherRows.length > 0) {
    console.log("\n=== 'other' samples (would-be misfires) ===");
    for (const r of otherRows.slice(0, 5)) {
      console.log(`  Q${r.q.questionNum} (${r.q.examPaper.level}): ${r.reason}`);
      console.log(`    stem: ${(r.q.transcribedStem ?? "").slice(0, 120)}`);
    }
  }

  const outDir = path.join(__dirname, "..", "eval", "derived-buckets");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${slug(TOPIC!)}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    topic: TOPIC, sampleSize: sample.length, poolSize: oeqs.length,
    buckets, distribution: counts, otherSamples: otherRows.slice(0, 10).map(r => ({ qId: r.q.id, qNum: r.q.questionNum, reason: r.reason, stemHead: (r.q.transcribedStem ?? "").slice(0, 200) })),
  }, null, 2));
  console.log(`\nWrote ${outPath}`);

  await prisma.$disconnect();
})();
