// Classify every Science master question against the taxonomy in
// src/lib/science-subtopics.ts and write subTopic to DB.
//
// Dry-run by default. Pass --apply to write.
// Pass --topic="..." to scope to one topic.
// Pass --reclass to also re-classify rows that already have a subTopic
// (default skips them).
//
// Cost: ~$0.0002 per Q at Gemini 2.5-flash, full sweep ~$0.30.

import { promises as fs } from "fs";
import path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";
import { prisma } from "../src/lib/db";
import { SCIENCE_SUBTOPIC_TAXONOMY } from "../src/lib/science-subtopics";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--(\w+)(?:=(.+))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
) as { apply?: boolean; topic?: string; reclass?: boolean };

const APPLY = !!args.apply;
const ONE_TOPIC = typeof args.topic === "string" ? args.topic : null;
const RECLASS = !!args.reclass;

type Q = {
  id: string;
  questionNum: string;
  syllabusTopic: string | null;
  subTopic: string | null;
  marksAvailable: number | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  answer: string | null;
};

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

async function classifyOne(q: Q, topicEntry: typeof SCIENCE_SUBTOPIC_TAXONOMY[number]): Promise<string | null> {
  const buckets = topicEntry.buckets;
  const block = buckets.map(b => `- "${b.id}": ${b.description}`).join("\n");
  const ids = buckets.map(b => `"${b.id}"`).join(", ");
  const ans = (q.answer ?? "").trim();
  const prompt = `Sub-topic of "${topicEntry.topic}". Pick the SINGLE best fit.

${block}

QUESTION (${q.marksAvailable} marks):
${questionText(q)}

ANSWER KEY:
${ans || "(none)"}

If genuinely none fit, return "other".

JSON: { "subTopic": "..." }
subTopic must be one of: ${ids}, "other".`;
  try {
    const res = await generateContentWithRetry(
      { model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } },
      1, 3000, `subtopic:${q.id.slice(-6)}`,
    );
    const j = JSON.parse(res.text ?? "");
    return typeof j.subTopic === "string" ? j.subTopic : null;
  } catch {
    return null;
  }
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (writing DB)" : "DRY RUN"}`);
  if (ONE_TOPIC) console.log(`Scoped to: "${ONE_TOPIC}"`);
  if (RECLASS) console.log(`Re-classifying rows that already have a subTopic`);

  const topics = ONE_TOPIC
    ? SCIENCE_SUBTOPIC_TAXONOMY.filter(t => t.topic === ONE_TOPIC)
    : SCIENCE_SUBTOPIC_TAXONOMY;
  if (topics.length === 0) {
    console.error(`Topic "${ONE_TOPIC}" not in taxonomy. Bail.`);
    process.exit(1);
  }

  const summary: { topic: string; classified: number; skipped: number; distribution: Record<string, number> }[] = [];

  for (const t of topics) {
    const where = {
      examPaper: {
        paperType: null, sourceExamId: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" as const },
        level: { in: ["P4", "Primary 4", "4", "P5", "Primary 5", "5", "P6", "Primary 6", "6", "PSLE"] },
      },
      syllabusTopic: t.topic,
      ...(RECLASS ? {} : { subTopic: null }),
    };
    const pool = await prisma.examQuestion.findMany({
      where,
      select: {
        id: true, questionNum: true, syllabusTopic: true, subTopic: true,
        marksAvailable: true, transcribedStem: true, transcribedOptions: true, answer: true,
      },
      orderBy: { id: "asc" },
    });

    console.log(`\n${t.topic} — ${pool.length} questions to classify`);
    const distribution: Record<string, number> = { other: 0, "(no-resp)": 0 };
    for (const b of t.buckets) distribution[b.id] = 0;

    let classified = 0;
    for (let i = 0; i < pool.length; i++) {
      const q = pool[i];
      const sub = await classifyOne(q, t);
      const tag = sub ?? "(no-resp)";
      distribution[tag] = (distribution[tag] ?? 0) + 1;
      if (sub && sub !== "other" && t.buckets.some(b => b.id === sub)) {
        classified++;
        if (APPLY) {
          await prisma.examQuestion.update({ where: { id: q.id }, data: { subTopic: sub } });
        }
      }
      if ((i + 1) % 25 === 0 || i + 1 === pool.length) {
        process.stdout.write(`  [${i + 1}/${pool.length}] ${tag.padEnd(36)}\n`);
      }
    }
    summary.push({ topic: t.topic, classified, skipped: pool.length - classified, distribution });
  }

  console.log("\n\n=== Summary ===");
  for (const s of summary) {
    console.log(`\n${s.topic}: classified ${s.classified}, skipped ${s.skipped}`);
    for (const [k, n] of Object.entries(s.distribution).sort((a, b) => b[1] - a[1])) {
      if (n > 0) console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
  }

  const outPath = path.join(__dirname, "..", "eval", `subtopic-classify-${APPLY ? "applied" : "dryrun"}-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);

  await prisma.$disconnect();
})();
