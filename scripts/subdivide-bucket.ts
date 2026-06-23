// Re-derive sub-buckets WITHIN an over-large bucket. Pulls the
// questions that fell into the target bucket from a previous derive
// run's output, then asks Gemini for a finer split.
//
// Usage:
//   npx tsx scripts/subdivide-bucket.ts \
//     --topic="Interaction of forces (Frictional force, gravitational force, elastic spring force)" \
//     --bucket="applying-force-concepts"

import { promises as fs } from "fs";
import path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";
import { prisma } from "../src/lib/db";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--(\w+)=(.+)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
) as { topic?: string; bucket?: string };

const TOPIC = args.topic;
const BUCKET = args.bucket;
if (!TOPIC || !BUCKET) { console.error("--topic= and --bucket= required"); process.exit(1); }

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

type Q = {
  id: string; questionNum: string; marksAvailable: number | null;
  transcribedStem: string | null; answer: string | null; transcribedOptions: unknown;
  examPaper: { title: string; level: string | null };
};

(async () => {
  // Pull the full topic pool, then re-classify each against the
  // existing (parent) bucket set to find the ones in the target bucket.
  // Faster: re-read the parent derive's distribution from disk and
  // re-classify with the parent prompt, then filter to BUCKET.
  // Even simpler: pull the full pool, ask Gemini to identify the
  // sub-clusters within the target-bucket questions in one go.
  //
  // We take the FAST PATH: re-classify the full pool against parent
  // buckets to find the BUCKET members, then sub-cluster them.
  const parentFile = path.join(__dirname, "..", "eval", "derived-buckets", `${slug(TOPIC!)}.json`);
  const parent = JSON.parse(await fs.readFile(parentFile, "utf-8"));
  const parentBuckets: { id: string; description: string }[] = parent.buckets;
  console.log(`Parent buckets for ${TOPIC}:`);
  for (const b of parentBuckets) console.log(`  - ${b.id}`);

  const fetched = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
        level: { in: ["P5", "Primary 5", "5", "P6", "Primary 6", "6", "PSLE"] },
      },
      marksAvailable: { gte: 2 },
      syllabusTopic: TOPIC,
    },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, answer: true,
      examPaper: { select: { title: true, level: true } },
    },
  });
  const isOEQ = (o: unknown) => o == null || (Array.isArray(o) && o.length !== 4);
  const oeqs = fetched.filter(q => isOEQ(q.transcribedOptions) &&
    ((q.transcribedStem ?? "").trim().length > 0 || (q.answer ?? "").trim().length > 0));

  // Re-classify to find members of BUCKET
  const block = parentBuckets.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const ids = parentBuckets.map(b => `"${b.id}"`).join(", ");
  console.log(`\nRe-classifying ${oeqs.length} questions to find members of "${BUCKET}"…`);
  const members: Q[] = [];
  let i = 0;
  for (const q of oeqs) {
    i++;
    const stem = (q.transcribedStem ?? "").trim();
    const ans = (q.answer ?? "").trim();
    const prompt = `Topic: ${TOPIC}. Pick the SINGLE sub-topic that best fits.

Buckets:
${block}

QUESTION (${q.marksAvailable} marks):
${stem || "(no stem)"}

ANSWER KEY:
${ans || "(none)"}

JSON: { "subTopic": "..." }
subTopic must be one of: ${ids}, "other".`;
    try {
      const res = await generateContentWithRetry(
        { model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } },
        1, 3000, `reclass:${q.id.slice(-6)}`,
      );
      const j = JSON.parse(res.text ?? "");
      if (j.subTopic === BUCKET) members.push(q);
      process.stdout.write(`  [${i}/${oeqs.length}] ${j.subTopic === BUCKET ? "✓" : "·"}\n`);
    } catch (e) {
      process.stdout.write(`  [${i}/${oeqs.length}] (fail)\n`);
    }
  }
  console.log(`\nFound ${members.length} questions in "${BUCKET}". Asking Gemini for sub-clusters…`);

  if (members.length < 6) {
    console.log("Too few members to subdivide. Skipping.");
    return;
  }

  const memBlock = members.map((q, idx) => {
    const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
    const ans = (q.answer ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    return `[${idx}] (${q.marksAvailable}m, ${q.examPaper.level}) Q${q.questionNum}\nstem: ${stem || "(diagram-only)"}\nanswer: ${ans || "(no key)"}`;
  }).join("\n---\n");

  const derivePrompt = `You are reading ${members.length} Singapore Primary Science exam questions that all fell into a SINGLE sub-topic bucket called "${BUCKET}" within the syllabus topic "${TOPIC}".

Your job: subdivide them into 2 or 3 finer sub-buckets that capture distinct natural clusters in what these questions test.

QUESTIONS:
${memBlock}

Rules:
- 2 or 3 sub-buckets, each holding at least 5 questions in this sample.
- If the questions are genuinely uniform and don't sub-divide cleanly, return just 1 bucket (no subdivision needed).
- Bucket IDs: kebab-case, 2-3 words, scoped within "${BUCKET}".
- Bucket descriptions: one sentence each.

Respond with strict JSON:
{ "subBuckets": [ { "id": "...", "description": "..." }, ... ] }`;

  const res = await generateContentWithRetry(
    { model: "gemini-2.5-pro", contents: derivePrompt, config: { temperature: 0, responseMimeType: "application/json" } },
    1, 5000, `subdiv:${slug(BUCKET!).slice(0, 20)}`,
  );
  const j = JSON.parse(res.text ?? "");
  const sub: { id: string; description: string }[] = j.subBuckets ?? [];
  console.log(`\nProposed ${sub.length} sub-buckets:`);
  for (const b of sub) console.log(`  - ${b.id}: ${b.description}`);

  // Classify members against sub-buckets to validate distribution
  console.log(`\nValidating distribution…`);
  const counts: Record<string, number> = { other: 0 };
  for (const b of sub) counts[b.id] = 0;
  const subBlock = sub.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const subIds = sub.map(b => `"${b.id}"`).join(", ");
  let k = 0;
  for (const q of members) {
    k++;
    const stem = (q.transcribedStem ?? "").trim();
    const ans = (q.answer ?? "").trim();
    const prompt = `Sub-divide within parent bucket "${BUCKET}" (topic: ${TOPIC}). Pick ONE.

${subBlock}

QUESTION (${q.marksAvailable} marks):
${stem || "(no stem)"}

ANSWER KEY:
${ans || "(none)"}

JSON: { "subTopic": "..." }
subTopic must be one of: ${subIds}, "other".`;
    try {
      const r = await generateContentWithRetry(
        { model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } },
        1, 3000, `subclass:${q.id.slice(-6)}`,
      );
      const jj = JSON.parse(r.text ?? "");
      const st = jj.subTopic ?? "other";
      counts[st] = (counts[st] ?? 0) + 1;
    } catch { counts.other++; }
  }
  console.log("\nDistribution:");
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const flag = n < 5 ? "  ⚠ thin" : "";
    console.log(`  ${String(n).padStart(3)}  ${k}${flag}`);
  }

  await prisma.$disconnect();
})();
