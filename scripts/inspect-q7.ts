import { prisma } from "../src/lib/db";
(async () => {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmomkbljz000z9wmzuuxu4yoz", questionNum: "7" },
    select: { answer: true, transcribedSubparts: true, sourceQuestionId: true, examPaper: { select: { paperType: true, sourceExamId: true } } },
  });
  console.log("paperType:", q?.examPaper.paperType, "sourceExamId:", q?.examPaper.sourceExamId);
  console.log("sourceQuestionId:", q?.sourceQuestionId);
  console.log("answer full:");
  console.log(q?.answer);
  console.log();
  console.log("subparts:");
  console.log(JSON.stringify(q?.transcribedSubparts, null, 2));
  await prisma.$disconnect();
})();
