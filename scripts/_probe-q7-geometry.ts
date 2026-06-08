import { prisma } from "../src/lib/db";

(async () => {
  const SOURCE = "cmozcbl4e001d11l7dro13hbp"; // P6 Focused: Geometry
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: SOURCE, questionNum: "7" },
    select: {
      id: true, questionNum: true, answer: true,
      studentAnswer: true, marksAwarded: true, marksAvailable: true,
      markingNotes: true, syllabusTopic: true, transcribedStem: true,
    },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
