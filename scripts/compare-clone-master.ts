import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmopk27fx0001102os8w2nffp";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, sourceQuestionId: true, answer: true, transcribedOptions: true, studentAnswer: true, marksAwarded: true },
  });
  for (const q of qs) {
    if (!q.sourceQuestionId) continue;
    const m = await prisma.examQuestion.findUnique({
      where: { id: q.sourceQuestionId },
      select: { questionNum: true, answer: true, transcribedOptions: true, examPaper: { select: { title: true } } },
    });
    console.log(`\nClone Q${q.questionNum}  → master Q${m?.questionNum} in "${m?.examPaper.title}"`);
    console.log(`  studentAnswer: ${JSON.stringify(q.studentAnswer)}  awarded: ${q.marksAwarded}`);
    console.log(`  clone.answer:  ${JSON.stringify(q.answer)}`);
    console.log(`  master.answer: ${JSON.stringify(m?.answer)}`);
    const cloneOpts = (q.transcribedOptions as string[] | null);
    const masterOpts = (m?.transcribedOptions as string[] | null);
    if (Array.isArray(cloneOpts)) {
      console.log(`  clone.options:  [${cloneOpts.map(o => o.slice(0, 25)).join(" | ")}]`);
    }
    if (Array.isArray(masterOpts)) {
      console.log(`  master.options: [${masterOpts.map(o => o.slice(0, 25)).join(" | ")}]`);
    }
  }
  await prisma.$disconnect();
})();
