import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmotxybqd0025d15sbzgwbza1";
  const p = await prisma.examPaper.findUnique({ where: { id: ID }, select: { title: true, subject: true, paperType: true } });
  console.log(`Paper: ${p?.title}  subject=${p?.subject}  type=${p?.paperType}`);
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: ID, questionNum: "3" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedSubparts: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
})();
