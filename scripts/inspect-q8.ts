import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmotxybqd0025d15sbzgwbza1";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: ID, questionNum: "8" },
    select: { id: true, transcribedStem: true, transcribedSubparts: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
})();
