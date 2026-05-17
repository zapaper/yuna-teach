import { prisma } from "../src/lib/db";

// Clears the cached AI elaboration for a specific question on a clone
// paper, plus its master question (so future clones inherit the
// fresh explanation). Usage:
//   npx tsx scripts/clear-q-elab.ts <paperId> <questionNum>

(async () => {
  const PAPER_ID = process.argv[2];
  const Q_NUM = process.argv[3];
  if (!PAPER_ID || !Q_NUM) {
    console.error("usage: clear-q-elab.ts <paperId> <questionNum>");
    process.exit(1);
  }
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: Q_NUM },
    select: { id: true, transcribedStem: true, elaboration: true, sourceQuestionId: true },
  });
  if (!q) { console.error(`Q${Q_NUM} not found on paper ${PAPER_ID}`); process.exit(1); }
  console.log(`Q${Q_NUM} id=${q.id}`);
  console.log(`stem: ${(q.transcribedStem ?? "").slice(0, 100)}`);
  console.log(`had cached elaboration: ${q.elaboration ? "yes" : "no"}`);
  await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: null } });
  if (q.sourceQuestionId) {
    await prisma.examQuestion.update({
      where: { id: q.sourceQuestionId },
      data: { elaboration: null },
    });
    console.log(`also cleared master ${q.sourceQuestionId}`);
  }
  await prisma.$disconnect();
})();
