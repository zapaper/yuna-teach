import { prisma } from "../src/lib/db";
(async () => {
  const PAPER_ID = "cmovfgwmm001gqodfz9p2054n";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: "10" },
    select: { id: true, transcribedStem: true, elaboration: true },
  });
  if (!q) { console.error("Q10 not found"); process.exit(1); }
  console.log(`Q10 id=${q.id}`);
  console.log(`stem: ${(q.transcribedStem ?? "").slice(0, 100)}`);
  console.log(`had cached elaboration: ${q.elaboration ? "yes" : "no"}`);
  await prisma.examQuestion.update({
    where: { id: q.id },
    data: { elaboration: null },
  });
  // Also clear the master, if linked, so other clones get the fresh
  // version too the next time someone hits Explain.
  const linked = await prisma.examQuestion.findUnique({
    where: { id: q.id },
    select: { sourceQuestionId: true },
  });
  if (linked?.sourceQuestionId) {
    await prisma.examQuestion.update({
      where: { id: linked.sourceQuestionId },
      data: { elaboration: null },
    });
    console.log(`also cleared master ${linked.sourceQuestionId}`);
  }
  await prisma.$disconnect();
})();
