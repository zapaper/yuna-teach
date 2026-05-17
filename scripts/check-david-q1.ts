import { prisma } from "../src/lib/db";
(async () => {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmoqkmwxa000pwu99qiiwf74x", questionNum: "1" },
    select: { studentAnswer: true, answer: true, marksAwarded: true, marksAvailable: true, markingNotes: true },
  });
  console.log("typeof:", typeof q?.studentAnswer);
  console.log("JSON-encoded value:", JSON.stringify(q?.studentAnswer));
  console.log("=== null:", q?.studentAnswer === null);
  console.log("=== 'null':", q?.studentAnswer === "null");
  console.log("full row:", q);
  await prisma.$disconnect();
})();
