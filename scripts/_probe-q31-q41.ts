import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = "cmq37ttgd0001cyy0fkgjiido";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: {
      id: true, title: true, subject: true, assignedToId: true,
      markingStatus: true, completedAt: true, updatedAt: true,
    },
  });
  console.log("Paper:", JSON.stringify(p, null, 2));

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { in: ["31", "41"] } },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, answer: true,
      studentAnswer: true, marksAwarded: true, marksAvailable: true,
      markingNotes: true, syllabusTopic: true,
    },
  });
  for (const q of qs) {
    console.log(`\nQ${q.questionNum} (${q.syllabusTopic}):`);
    console.log(`  expected:      ${q.answer}`);
    console.log(`  studentAnswer: ${q.studentAnswer}`);
    console.log(`  marksAwarded:  ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  markingNotes:  ${(q.markingNotes ?? "").slice(0, 300)}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
