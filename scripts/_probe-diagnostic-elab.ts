import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // Look at the math + science + english diagnostic quiz questions
  // — do they have elaboration populated, and are they inheriting
  // from the master?
  const paperIds = [
    "cmr1lvc99000hzp2nayw9ymkf",  // Math
    "cmr1lvegl000yzp2n90dxkr6r",  // Science
    "cmr1nfba300017ut6rjl0h5o8",  // English (new 20q)
  ];
  for (const paperId of paperIds) {
    const paper = await prisma.examPaper.findUnique({ where: { id: paperId }, select: { title: true } });
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paperId },
      select: { id: true, questionNum: true, elaboration: true, sourceQuestionId: true, marksAwarded: true, marksAvailable: true, transcribedOptions: true },
      orderBy: { orderIndex: "asc" },
      take: 5,
    });
    console.log(`\n── ${paper?.title} (${paperId}) ──`);
    for (const q of qs) {
      const cloneElab = (q.elaboration ?? "").length;
      const masterElab = q.sourceQuestionId
        ? (await prisma.examQuestion.findUnique({ where: { id: q.sourceQuestionId }, select: { elaboration: true } }))?.elaboration ?? ""
        : "";
      console.log(`  Q${q.questionNum}  clone.elab=${cloneElab}  master.elab=${masterElab.length}  aw=${q.marksAwarded ?? "—"}/${q.marksAvailable ?? "—"}  opts=${Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as unknown[]).length : "?"}`);
    }
  }
  await prisma.$disconnect();
})();
