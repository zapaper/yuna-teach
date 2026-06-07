import { prisma } from "../src/lib/db";
(async () => {
  const paper = await prisma.examPaper.findUnique({
    where: { id: "cmpgd6tzc002h10h2se9zdyfn" },
    select: {
      id: true, title: true, subject: true, level: true,
      paperType: true, examType: true, metadata: true,
      questions: {
        select: { id: true, questionNum: true, syllabusTopic: true, marksAvailable: true, transcribedStem: true, transcribedSubparts: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  console.log(`Paper: ${paper?.title}  subject=${paper?.subject}  paperType=${paper?.paperType}  examType=${paper?.examType}`);
  console.log(`Questions: ${paper?.questions.length}`);
  for (const q of paper?.questions ?? []) {
    const subs = Array.isArray(q.transcribedSubparts) ? (q.transcribedSubparts as Array<{label?:string;text?:string}>) : [];
    console.log(`  Q${q.questionNum} ${q.syllabusTopic ?? ""} marks=${q.marksAvailable} subparts=${subs.length}${subs.length ? " ("+subs.map(s=>s.label).join(",")+")" : ""}`);
  }
  await prisma.$disconnect();
})();
