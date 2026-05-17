import { prisma } from "../src/lib/db";

async function main() {
  const paperId = "cmom47iky0001hvw24vktsmxl";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paperId },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, transcribedStem: true, transcribedOptions: true,
      answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true,
      markingNotes: true, syllabusTopic: true,
    },
  });
  console.log(`Paper ${paperId}: ${qs.length} questions`);
  for (const q of qs) {
    if (q.questionNum !== "5" && !q.questionNum.startsWith("5")) continue;
    console.log(`\n=== Q${q.questionNum} [${q.syllabusTopic}] ===`);
    console.log(`  marks: ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  expected: ${JSON.stringify(q.answer)}`);
    console.log(`  student:  ${JSON.stringify(q.studentAnswer)}`);
    console.log(`  options:  ${JSON.stringify(q.transcribedOptions)}`);
    console.log(`  notes:    ${q.markingNotes}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
