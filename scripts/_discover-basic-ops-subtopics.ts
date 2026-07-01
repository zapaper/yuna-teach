// Sample 60 P4 + 60 P5 Basic-math-operations MCQs and ask Gemini to
// propose a sub-topic taxonomy that would let a diagnostic pick
// 3 MCQs from each of 4-6 categories. Two-pass:
//   1. Collect stems from 120 sampled rows.
//   2. Ask Gemini to propose a taxonomy + assign each row to a bucket.
//
// Output: writes eval/basic-ops-taxonomy-proposal.json with the
// proposed clusters and per-question assignments, so we can eyeball
// before creating a real classifier + writing subTopic to DB.
//
// Run (background OK — takes ~2-3 min for the Gemini call):
//   npx tsx scripts/_discover-basic-ops-subtopics.ts

import "dotenv/config";
import { writeFile } from "fs/promises";
import path from "path";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

type Q = {
  id: string; level: string; questionNum: string;
  transcribedStem: string; transcribedOptions: string[]; answer: string;
};

function stemPreview(q: Q, maxChars = 400): string {
  const opts = q.transcribedOptions.map((o, i) => `${i + 1}) ${o}`).join(" · ");
  const raw = `${q.transcribedStem} — Options: ${opts}${q.answer ? ` — Answer: ${q.answer}` : ""}`;
  return raw.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function pickSample(level: string, target = 60): Promise<Q[]> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { in: ["Basic math operations", "Basic Math Operations"] },
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "math", mode: "insensitive" },
        level,
      },
    },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      transcribedOptions: true, answer: true,
    },
  });
  const mcq = rows.filter(r =>
    Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2 &&
    (r.transcribedStem ?? "").length > 20,
  );
  // Deterministic sample: sort by id, then take up to `target`.
  mcq.sort((a, b) => a.id.localeCompare(b.id));
  const picked = mcq.slice(0, target);
  return picked.map(r => ({
    id: r.id, level, questionNum: r.questionNum,
    transcribedStem: r.transcribedStem ?? "",
    transcribedOptions: Array.isArray(r.transcribedOptions) ? (r.transcribedOptions as string[]) : [],
    answer: r.answer ?? "",
  }));
}

(async () => {
  console.log(`Sampling P4 + P5 Basic ops master MCQs …`);
  const p4 = await pickSample("Primary 4", 60);
  const p5 = await pickSample("Primary 5", 60);
  console.log(`  P4 picked: ${p4.length}`);
  console.log(`  P5 picked: ${p5.length}`);
  const all = [...p4, ...p5];
  if (all.length === 0) { console.error("no samples"); process.exit(1); }

  const numbered = all.map((q, i) => `[${i + 1}] (${q.level.replace("Primary ", "P")} Q${q.questionNum}) ${stemPreview(q)}`).join("\n\n");
  const prompt = `You are analysing a bank of Primary 4 and Primary 5 "Basic math operations" MCQs from Singapore school papers. The current tag "Basic math operations" is too coarse — a topic-diagnostic needs 4-6 SUB-TOPICS so it can pick 3 MCQs from each and cover the child's actual skills.

Task:
1. Propose 4-6 sub-topic buckets that make pedagogical sense (e.g. "addition + subtraction", "multiplication + division", "order of operations", "word problems: money", "word problems: measurement", etc.). Each bucket should be a slug (lowercase, hyphen-separated) plus a one-sentence description.
2. Assign every one of the ${all.length} numbered questions below to exactly ONE bucket by its index number [N].
3. Return valid JSON only, no prose. Shape:

{
  "buckets": [
    { "id": "kebab-slug", "label": "Human Label", "description": "one sentence explaining what belongs here" }
  ],
  "assignments": {
    "1": "bucket-id",
    "2": "bucket-id",
    ...
  }
}

Constraints:
- Every bucket should end up with at least 3 questions in the assignments (otherwise pick fewer, more general buckets).
- A question that's about applying operations to a real-life scenario (money, distance, weight) counts as a "word problem" — bucket those separately if a bucket for word problems fits your taxonomy.
- Keep the taxonomy at the granularity a P4/P5 kid would recognise; don't split "single-digit subtraction" from "two-digit subtraction".

Questions:
${numbered}`;

  console.log(`\nCalling Gemini (prompt = ${prompt.length} chars) …`);
  const t0 = Date.now();
  const resp = await generateContentWithRetry({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const raw = resp.text ?? "";
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  done in ${dt}s (${raw.length} chars)`);

  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); }
  catch (e) { console.error(`JSON parse fail: ${(e as Error).message}`); }

  const out = {
    generatedAt: new Date().toISOString(),
    sampleSizes: { p4: p4.length, p5: p5.length, total: all.length },
    indexToQuestionId: Object.fromEntries(all.map((q, i) => [i + 1, { id: q.id, level: q.level, qNum: q.questionNum }])),
    geminiRaw: raw,
    geminiParsed: parsed,
  };
  const outPath = path.join(__dirname, "..", "eval", "basic-ops-taxonomy-proposal.json");
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`\nWrote ${outPath}`);

  // Print bucket summary if parseable.
  if (parsed && typeof parsed === "object" && "buckets" in parsed && "assignments" in parsed) {
    const p = parsed as { buckets: Array<{ id: string; label: string; description: string }>; assignments: Record<string, string> };
    const counts = new Map<string, number>();
    for (const b of Object.values(p.assignments)) counts.set(b, (counts.get(b) ?? 0) + 1);
    console.log(`\nProposed taxonomy:`);
    for (const b of p.buckets) {
      const n = counts.get(b.id) ?? 0;
      console.log(`  ${b.id.padEnd(30)}  n=${n.toString().padStart(3)}  — ${b.label}`);
      console.log(`    ${b.description}`);
    }
    console.log(`\n(re-run with --apply once you're happy with the taxonomy)`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
