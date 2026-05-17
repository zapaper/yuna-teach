import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmonj2jy6000g8eodfzfsyiec";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { paperType: true, markingStatus: true, score: true, totalMarks: true, completedAt: true, updatedAt: true },
  });
  console.log("paper:", p);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["12", "14"] } },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true, transcribedSubparts: true, studentAnswer: true, markingNotes: true },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}`);
    const subs = (q.transcribedSubparts as Array<{label: string; text: string}> | null) ?? [];
    const real = subs.filter(s => !s.label.startsWith("_"));
    console.log(`  subparts: ${real.map(s => s.label).join(", ")}`);
    console.log(`  studentAnswer: ${JSON.stringify(q.studentAnswer)?.slice(0, 300)}`);
    console.log(`  markingNotes:`);
    console.log("    " + (q.markingNotes ?? "").replace(/\n/g, "\n    "));
  }
  await prisma.$disconnect();
})();
