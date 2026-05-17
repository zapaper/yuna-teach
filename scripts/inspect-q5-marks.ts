import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmoshbgrb001k13l0xutifd4f";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: ID, questionNum: "5" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedSubparts: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
})();
