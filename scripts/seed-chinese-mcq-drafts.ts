// Seed the chinese_mcq_drafts table from chinese-mcq-drafts.json.
// Idempotent: skips drafts that already exist by (seedWord, shape, stem)
// fingerprint — re-runnable when the generator script produces new
// drafts.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type Draft = {
  seedWord: string;
  seedMeaning: string;
  shape: "Q5-Q6" | "Q7-Q8" | "Q9-Q10";
  stem: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  syllabusTopic: string;
  subTopic: string;
  priority: number;
};

(async () => {
  const file = path.join(__dirname, "chinese-mcq-drafts.json");
  if (!fs.existsSync(file)) {
    console.error(`Drafts JSON not found at ${file}`);
    process.exit(1);
  }
  const drafts = JSON.parse(fs.readFileSync(file, "utf8")) as Draft[];
  console.log(`Loaded ${drafts.length} drafts from JSON.`);

  // Pull existing rows for dedupe — match by (seedWord, shape, stem).
  const existing = await prisma.chineseMcqDraft.findMany({
    select: { seedWord: true, shape: true, stem: true },
  });
  const seen = new Set(existing.map(e => `${e.seedWord}|${e.shape}|${e.stem.slice(0, 80)}`));
  console.log(`Existing rows in DB: ${existing.length}`);

  let inserted = 0;
  for (const d of drafts) {
    const key = `${d.seedWord}|${d.shape}|${d.stem.slice(0, 80)}`;
    if (seen.has(key)) continue;
    await prisma.chineseMcqDraft.create({
      data: {
        seedWord: d.seedWord,
        seedMeaning: d.seedMeaning,
        shape: d.shape,
        stem: d.stem,
        options: d.options,
        correctAnswer: d.correctAnswer,
        explanation: d.explanation,
        syllabusTopic: d.syllabusTopic,
        subTopic: d.subTopic,
        priority: d.priority,
        status: "pending",
      },
    });
    inserted++;
  }
  console.log(`Inserted ${inserted} new drafts (deduped against existing).`);
  await prisma.$disconnect();
})();
