// Re-tag Q21 of "P6 Life Science MCQ 2022-2024" from
// "Plant respiratory and circulatory systems" to "Plant parts and
// functions" — the question is about phloem transport, which sits
// under plant-parts in the P5/P6 taxonomy.
//
// Run from yuna-teach/:
//   DRY-RUN: npx tsx scripts/retag-q21-life-science.ts
//   APPLY:   npx tsx scripts/retag-q21-life-science.ts --apply
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const Q_ID = "cmoqvxgxp006vwu99d0xfk5ym";
const NEW_TOPIC = "Plant parts and functions";

async function main() {
  const before = await prisma.examQuestion.findUnique({
    where: { id: Q_ID },
    select: { id: true, questionNum: true, syllabusTopic: true, examPaper: { select: { title: true } } },
  });
  if (!before) { console.log("Question not found"); return; }
  console.log(`Paper: ${before.examPaper.title}`);
  console.log(`Q${before.questionNum} (${before.id})`);
  console.log(`  before: "${before.syllabusTopic}"`);
  console.log(`  after : "${NEW_TOPIC}"`);

  if (!APPLY) {
    console.log("\nDry-run — re-run with --apply to commit.");
    return;
  }
  await prisma.examQuestion.update({
    where: { id: Q_ID },
    data: { syllabusTopic: NEW_TOPIC },
  });
  console.log("\nApplied.");
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
