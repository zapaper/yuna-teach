// Reset a cloned quiz / focused-test / paper so it can be re-marked or
// re-scanned. Clears every per-question marking field (marksAwarded,
// studentAnswer, markingNotes) and resets the clone's
// markingStatus + score so the next markExamPaper run starts fresh.
//
// Usage:
//   npx tsx scripts/unmark-clone.ts <cloneId> [<cloneId> ...]

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function unmarkOne(cloneId: string) {
  const paper = await prisma.examPaper.findUnique({
    where: { id: cloneId },
    select: { id: true, title: true, markingStatus: true, score: true, sourceExamId: true, assignedToId: true, paperType: true },
  });
  if (!paper) {
    console.error(`[unmark] not found: ${cloneId}`);
    return;
  }
  // Safety: only clear when the paper is plausibly a student-assigned
  // instance. Quiz/focused often don't carry sourceExamId — they ARE
  // the assigned instance — so also accept an assignedToId or a
  // quiz/focused paperType. Bail only when none of those hold (= a
  // bare master paper that no student ever touched).
  if (!paper.sourceExamId && !paper.assignedToId && paper.paperType !== "quiz" && paper.paperType !== "focused") {
    console.warn(`[unmark] WARNING: ${cloneId} (${paper.title}) is a bare master paper (no sourceExamId, no assignedToId, paperType=${paper.paperType}). Skipping for safety.`);
    return;
  }
  console.log(`[unmark] ${cloneId} (${paper.title}): status=${paper.markingStatus}, score=${paper.score}, paperType=${paper.paperType} → resetting`);

  const r = await prisma.examQuestion.updateMany({
    where: { examPaperId: cloneId },
    data: {
      marksAwarded: 0,
      studentAnswer: "",
      markingNotes: null,
    },
  });
  await prisma.examPaper.update({
    where: { id: cloneId },
    data: { markingStatus: null, score: 0, completedAt: null },
  });
  console.log(`[unmark] ${cloneId}: cleared ${r.count} questions. Ready to re-mark or re-scan.`);
}

(async () => {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("Usage: npx tsx scripts/unmark-clone.ts <cloneId> [<cloneId> ...]");
    process.exit(1);
  }
  for (const id of ids) await unmarkOne(id);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
