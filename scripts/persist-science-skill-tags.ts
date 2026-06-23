// Persist the classifier output (eval/science-skill-tags.json) into
// ExamQuestion.skillTags on the Railway DB. Idempotent — re-running
// re-writes the same array of tags. Designed to be safe to interrupt:
// each Q is a separate UPDATE, no transactions hold across questions.
//
// Usage:
//   set -a && source .env && set +a && npx tsx scripts/persist-science-skill-tags.ts
//
// Use the env override pattern in MEMORY.md (DIRECT_URL trap) if you
// hit any prisma migrate / db issues alongside this.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { SCIENCE_SKILL_TAGS, type ScienceSkillTag } from "../src/lib/science-skills";

const INPUT = path.join(__dirname, "..", "eval", "science-skill-tags.json");

type ResultRow = {
  id: string;
  questionNum: string;
  topic: string;
  paper: string;
  year: string | null;
  marks: number;
  skillTags: ScienceSkillTag[];
  reason: string;
};

(async () => {
  const raw = await fs.readFile(INPUT, "utf-8");
  const data = JSON.parse(raw) as { results: ResultRow[]; generatedAt: string };
  console.log(`Loaded ${data.results.length} rows from ${INPUT}`);
  console.log(`Classifier ran: ${data.generatedAt}\n`);

  // Validate the tag set in the file matches what we have on the
  // server now — if someone changed the vocabulary between
  // classification and persist, the bogus tags would be a silent
  // landmine for the Lumi-quiz endpoint to step on later.
  const valid = new Set<string>(SCIENCE_SKILL_TAGS);
  let bogus = 0;
  for (const r of data.results) {
    for (const tag of r.skillTags) {
      if (!valid.has(tag)) {
        console.warn(`  ⚠ unknown tag "${tag}" on Q${r.questionNum} (${r.id})`);
        bogus++;
      }
    }
  }
  if (bogus > 0) {
    console.error(`Aborting: ${bogus} unknown tag(s) in input file. Update src/lib/science-skills.ts or re-classify.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Update in batches. examQuestion.update is per-row in Postgres
  // anyway (no bulk update with different values per row), so just
  // loop sequentially with a progress log every 50.
  let written = 0;
  let unchanged = 0;
  let missing = 0;

  for (const r of data.results) {
    // Sanity: row still in DB?
    const existing = await prisma.examQuestion.findUnique({
      where: { id: r.id },
      select: { skillTags: true },
    });
    if (!existing) {
      missing++;
      continue;
    }
    // Skip if the array already matches — keeps re-runs cheap.
    const same =
      existing.skillTags.length === r.skillTags.length &&
      existing.skillTags.every((t, i) => t === r.skillTags[i]);
    if (same) {
      unchanged++;
      continue;
    }
    await prisma.examQuestion.update({
      where: { id: r.id },
      data: { skillTags: r.skillTags },
    });
    written++;
    if ((written + unchanged) % 50 === 0) {
      console.log(`  ${written + unchanged + missing}/${data.results.length} done (wrote ${written}, unchanged ${unchanged}, missing ${missing})`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  wrote:     ${written}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  missing:   ${missing}  (rows in JSON but not in DB — likely deleted)`);

  // Quick distribution check
  const tagged = await prisma.examQuestion.count({ where: { skillTags: { isEmpty: false } } });
  console.log(`\nTotal ExamQuestion rows with any skillTags now: ${tagged}`);
  for (const tag of SCIENCE_SKILL_TAGS) {
    const n = await prisma.examQuestion.count({ where: { skillTags: { has: tag } } });
    console.log(`  ${tag.padEnd(28)} ${n}`);
  }
  await prisma.$disconnect();
})();
