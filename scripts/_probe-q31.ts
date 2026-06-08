import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = "cmq37ttgd0001cyy0fkgjiido";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: {
      id: true, title: true, subject: true,
      markingStatus: true, completedAt: true,
      updatedAt: true,
    },
  });
  console.log("Paper:", JSON.stringify(p, null, 2));

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER, questionNum: "31" },
    select: {
      id: true, questionNum: true, answer: true,
      studentAnswer: true, marksAwarded: true, marksAvailable: true,
      markingNotes: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true,
    },
  });
  console.log("\nQ31:", JSON.stringify(q, null, 2));

  // Look at sibling Grammar Cloze qs for context
  const siblings = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, syllabusTopic: "Grammar Cloze" },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, answer: true, studentAnswer: true,
      marksAwarded: true, marksAvailable: true,
    },
  });
  console.log("\nGrammar Cloze siblings:");
  for (const s of siblings) {
    console.log(`  Q${s.questionNum}: answer=${s.answer} studentAnswer=${s.studentAnswer} awarded=${s.marksAwarded}/${s.marksAvailable}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
