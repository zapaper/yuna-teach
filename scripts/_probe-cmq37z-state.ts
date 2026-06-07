import { prisma } from "../src/lib/db";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, score: true, totalMarks: true, markingStatus: true, completedAt: true },
  });
  console.log("Paper:", JSON.stringify(p, null, 2));
  const count = await prisma.examQuestion.count({ where: { examPaperId: PAPER } });
  console.log(`Total questions: ${count}`);
  const marked = await prisma.examQuestion.count({ where: { examPaperId: PAPER, marksAwarded: { not: null } } });
  console.log(`With marksAwarded: ${marked}`);
  const withNotes = await prisma.examQuestion.count({ where: { examPaperId: PAPER, markingNotes: { not: null } } });
  console.log(`With markingNotes: ${withNotes}`);
  const sample = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    take: 5,
    select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true, markingNotes: true, studentAnswer: true, syllabusTopic: true, pageIndex: true },
  });
  for (const q of sample) {
    console.log(`Q${q.questionNum} (orderIndex N/A): ${q.marksAwarded}/${q.marksAvailable}  topic=${q.syllabusTopic}  page=${q.pageIndex}`);
    console.log(`  studentAnswer: ${q.studentAnswer?.slice(0, 80)}`);
    console.log(`  notes: ${q.markingNotes?.slice(0, 100)}`);
  }
  process.exit(0);
}
main();
