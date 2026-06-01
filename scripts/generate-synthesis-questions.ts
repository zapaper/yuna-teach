// Generate synthetic Synthesis & Transformation questions for a
// specific sub-topic. Picks N random source-paper questions of that
// sub-topic, runs each through generateSyntheticSynthesis with the
// targetSubTopic locked, and writes the resulting variants to a JSON
// file for review.
//
// Usage:
//   npx tsx scripts/generate-synthesis-questions.ts <subTopic> [count]
//
// Examples:
//   npx tsx scripts/generate-synthesis-questions.ts concession 5
//   npx tsx scripts/generate-synthesis-questions.ts relative-clause 3
//   npx tsx scripts/generate-synthesis-questions.ts preference
//
// Output goes to:
//   eval/synthetic-synthesis-<subTopic>-<timestamp>.json
//
// Review the file, then decide whether to import the variants into the
// question bank (separate ingestion step — not auto-written to DB).

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { generateSyntheticSynthesis } from "../src/lib/gemini";

const VALID_SUBTOPICS = [
  "concession", "cause", "condition", "reported-speech",
  "preference", "participle-having", "inclusion-correlative", "relative-clause",
] as const;

async function main() {
  const [subTopicArg, countArg] = process.argv.slice(2);
  if (!subTopicArg || !VALID_SUBTOPICS.includes(subTopicArg as (typeof VALID_SUBTOPICS)[number])) {
    console.error(`Usage: npx tsx scripts/generate-synthesis-questions.ts <subTopic> [count]`);
    console.error(`Valid sub-topics: ${VALID_SUBTOPICS.join(", ")}`);
    process.exit(1);
  }
  const subTopic = subTopicArg;
  const count = Math.max(1, parseInt(countArg ?? "3", 10));

  // Pull source-paper questions matching this sub-topic. visible=true
  // restricts to canonical PSLE/Prelim bank rows (not student-attempt
  // clones).
  const pool = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      subTopic,
      examPaper: { visible: true },
      transcribedStem: { not: null },
      answer: { not: null },
    },
    select: {
      id: true,
      transcribedStem: true,
      answer: true,
      examPaper: { select: { title: true, year: true } },
    },
  });
  if (pool.length === 0) {
    console.error(`No source questions tagged subTopic="${subTopic}" — run scripts/_classify-synthesis.ts --apply first?`);
    process.exit(1);
  }
  console.log(`Pool: ${pool.length} source questions tagged "${subTopic}".`);
  console.log(`Generating ${count} pairs (each call produces "simple" + "similar" variants → ${count * 2} total items).\n`);

  // Pick N distinct sources at random.
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, Math.min(count, pool.length));

  const results: Array<{
    sourceId: string;
    sourcePaper: string;
    originalStem: string;
    originalAnswer: string;
    simple: { stem: string; answer: string; keyword: string };
    similar: { stem: string; answer: string; keyword: string };
  }> = [];

  for (let i = 0; i < picks.length; i++) {
    const src = picks[i];
    process.stdout.write(`[${i + 1}/${picks.length}] generating from ${src.examPaper.title?.slice(0, 50)} … `);
    try {
      const { simple, similar } = await generateSyntheticSynthesis(
        src.transcribedStem!,
        src.answer!,
        subTopic,
      );
      results.push({
        sourceId: src.id,
        sourcePaper: `${src.examPaper.title} (${src.examPaper.year ?? "?"})`,
        originalStem: src.transcribedStem!,
        originalAnswer: src.answer!,
        simple, similar,
      });
      process.stdout.write(`ok\n`);
    } catch (err) {
      process.stdout.write(`FAILED: ${(err as Error).message.slice(0, 120)}\n`);
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join("eval", `synthetic-synthesis-${subTopic}-${ts}.json`);
  await fs.mkdir("eval", { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ subTopic, generatedAt: new Date().toISOString(), items: results }, null, 2));
  console.log(`\nWrote ${results.length} pairs (${results.length * 2} new items) to ${outPath}.`);
  console.log(`Review the file before importing into the question bank.`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
