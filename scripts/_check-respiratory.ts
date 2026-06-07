import { prisma } from "../src/lib/db";
async function main() {
  const p = await prisma.examPaper.findFirst({
    where: { id: { startsWith: "cmpuhzt5d" } },
    select: { id: true, title: true, score: true, markingStatus: true, totalMarks: true },
  });
  console.log(p);
  if (p) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { questionNum: true, marksAwarded: true, marksAvailable: true, studentAnswer: true },
      orderBy: { orderIndex: "asc" },
    });
    console.log(`\n${qs.length} questions total, ${qs.filter(q => q.marksAwarded !== null).length} marked`);
    for (const q of qs) {
      const sa = q.studentAnswer ? `"${q.studentAnswer.slice(0, 60).replace(/\n/g, " ")}"` : "(null)";
      console.log(`  Q${q.questionNum.padEnd(4)} ${q.marksAwarded ?? "?"}/${q.marksAvailable ?? "?"}   student: ${sa}`);
    }
  }
  await prisma.$disconnect();
}
main();
