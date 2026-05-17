import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmosfj32p000f6r3v91udj8n6";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, paperType: true, subject: true, score: true, totalMarks: true, completedAt: true },
  });
  console.log("paper:", p);
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: ID, questionNum: "7" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedSubparts: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  console.log("\nQ7:");
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
})();
