// Backfill transcribed fields on cloned ExamPaper questions where the
// master has them but the clone doesn't. Caused by the pre-fix clone
// code dropping transcribedStem / transcribedOptions / etc.
// Usage:
//   npx tsx scripts/backfill-clone-transcribed.ts <cloneId>     # one paper
//   npx tsx scripts/backfill-clone-transcribed.ts --all         # every clone
import { prisma } from "../src/lib/db";

async function backfillOne(cloneId: string): Promise<{ updated: number; skipped: string }> {
  const clone = await prisma.examPaper.findUnique({
    where: { id: cloneId },
    select: { id: true, title: true, sourceExamId: true },
  });
  if (!clone) return { updated: 0, skipped: "clone not found" };
  if (!clone.sourceExamId) return { updated: 0, skipped: "no sourceExamId (not a clone)" };

  const cloneQs = await prisma.examQuestion.findMany({
    where: { examPaperId: clone.id },
    select: { id: true, questionNum: true, transcribedStem: true },
  });
  const masterQs = await prisma.examQuestion.findMany({
    where: { examPaperId: clone.sourceExamId },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      syllabusTopic: true,
    },
  });
  const masterByNum = new Map(masterQs.map(q => [q.questionNum, q]));

  let updated = 0;
  for (const cq of cloneQs) {
    if (cq.transcribedStem) continue; // already has it
    const mq = masterByNum.get(cq.questionNum);
    if (!mq || !mq.transcribedStem) continue; // master has no transcribed either
    await prisma.examQuestion.update({
      where: { id: cq.id },
      data: {
        transcribedStem: mq.transcribedStem,
        transcribedOptions: mq.transcribedOptions ?? undefined,
        transcribedOptionImages: mq.transcribedOptionImages ?? undefined,
        transcribedOptionTable: mq.transcribedOptionTable ?? undefined,
        transcribedSubparts: mq.transcribedSubparts ?? undefined,
        sourceQuestionId: mq.id,
        // Also sync syllabusTopic in case the clone is missing it.
        syllabusTopic: mq.syllabusTopic,
      },
    });
    updated++;
  }
  return { updated, skipped: "" };
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx scripts/backfill-clone-transcribed.ts <cloneId|--all>");
    process.exit(1);
  }
  if (arg === "--all") {
    // Every assigned clone (has sourceExamId + assignedToId).
    const clones = await prisma.examPaper.findMany({
      where: { sourceExamId: { not: null }, assignedToId: { not: null } },
      select: { id: true, title: true },
    });
    console.log(`Found ${clones.length} clones to scan`);
    let total = 0;
    for (const c of clones) {
      const r = await backfillOne(c.id);
      if (r.updated > 0) {
        console.log(`  ${c.id} (${c.title}): updated ${r.updated} questions`);
        total += r.updated;
      } else if (r.skipped) {
        console.log(`  ${c.id} (${c.title}): skipped (${r.skipped})`);
      }
    }
    console.log(`\nDone. ${total} questions backfilled across ${clones.length} clones.`);
  } else {
    const r = await backfillOne(arg);
    console.log(`${arg}: updated ${r.updated} questions${r.skipped ? ` (${r.skipped})` : ""}`);
  }
  await prisma.$disconnect();
})();
