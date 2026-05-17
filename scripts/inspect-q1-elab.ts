import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmotxyve2003kd15so36jlkcv";
  const p = await prisma.examPaper.findUnique({ where: { id: ID }, select: { title: true, subject: true, sourceExamId: true } });
  console.log(`Paper: ${p?.title}  subject=${p?.subject}  sourceExamId=${p?.sourceExamId}`);
  const cq = await prisma.examQuestion.findFirst({
    where: { examPaperId: ID, questionNum: "1" },
    select: { id: true, sourceQuestionId: true, transcribedStem: true, answer: true, elaboration: true },
  });
  console.log("\n--- Clone Q1 ---");
  console.log(JSON.stringify(cq, null, 2));
  if (cq?.sourceQuestionId) {
    const mq = await prisma.examQuestion.findUnique({
      where: { id: cq.sourceQuestionId },
      select: { id: true, examPaperId: true, transcribedStem: true, answer: true, elaboration: true },
    });
    console.log("\n--- Master Q1 ---");
    console.log(JSON.stringify(mq, null, 2));
  }
  await prisma.$disconnect();
})();
