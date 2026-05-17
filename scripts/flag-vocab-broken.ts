import { prisma } from "../src/lib/db";
(async () => {
  const PAPER_ID = "cmonui8ed006b8eod68tn71tr";
  // Flag every question in the broken Vocab Cloze section so the admin
  // sees them in /flagged and can navigate to the master to fix the
  // passage. Q6-Q9 are the clone questions in this section.
  const result = await prisma.examQuestion.updateMany({
    where: { examPaperId: PAPER_ID, questionNum: { in: ["6", "7", "8", "9"] } },
    data: {
      flagged: true,
      flaggedAt: new Date(),
      flagVoiceNote: "Vocab Cloze passage is broken: missing the 'indigenous' sentence that Q9 references, and contains a phantom marker (8) 'typically' that has no corresponding question. Q8 asks about 'clumsy' but passage marker (8) is 'typically'; Q9 asks about 'indigenous' but the word is missing from passage. Re-extract this section from the source paper.",
    },
  });
  console.log(`Flagged ${result.count} questions on ${PAPER_ID}`);
  await prisma.$disconnect();
})();
