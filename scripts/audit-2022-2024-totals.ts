// Audit per-paper totals for 2022-2024 to find the missing ~15 marks/year.
// Expected: MCQ 56m/yr × 3 = 168m, OEQ 44m/yr × 3 = 132m, total 300m.
import { prisma } from "../src/lib/db";

(async () => {
  const titles = [
    "P6 Life Science MCQ 2022-2024",
    "PSLE Physical Science MCQ 2022-2024",
    "PSLE Life Science OEQ 2022-2024",
    "PSLE Physical science OEQ 2022-2024",
  ];
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, title: { in: titles } },
    select: { id: true, title: true },
  });

  let grandTotalMarks = 0;
  let grandTotalQs = 0;
  let grandNullMarks = 0;
  let grandNoTopic = 0;
  console.log(`\nPer-paper totals:\n`);
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { questionNum: true, syllabusTopic: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    });
    const totalQs = qs.length;
    const totalMarks = qs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const nullMarks = qs.filter(q => q.marksAvailable == null).length;
    const noTopic = qs.filter(q => !q.syllabusTopic || q.syllabusTopic.trim() === "").length;
    console.log(`  ${p.title}`);
    console.log(`    questions: ${totalQs}   marks: ${totalMarks}   null-marks: ${nullMarks}   no-topic: ${noTopic}`);
    if (nullMarks > 0) {
      console.log(`    questions with null marks:`);
      for (const q of qs.filter(q => q.marksAvailable == null)) {
        console.log(`       Q${q.questionNum}  topic="${q.syllabusTopic ?? "—"}"`);
      }
    }
    grandTotalMarks += totalMarks;
    grandTotalQs += totalQs;
    grandNullMarks += nullMarks;
    grandNoTopic += noTopic;
  }
  console.log(`\nGrand totals: ${grandTotalQs} qs / ${grandTotalMarks} marks`);
  console.log(`Null-marks questions: ${grandNullMarks}`);
  console.log(`No-topic questions: ${grandNoTopic}`);
  console.log(`Expected for 3 PSLE years: 300 marks  → missing ${300 - grandTotalMarks} marks`);
  await prisma.$disconnect();
})();
