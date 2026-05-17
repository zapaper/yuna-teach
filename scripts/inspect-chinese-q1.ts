import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = "cmp82gjvw0001ezeovi1ml5i8";
  const paper = await prisma.examPaper.findUnique({ where: { id: PAPER_ID }, select: { title: true, subject: true } });
  console.log("Paper:", paper?.title, "|", paper?.subject);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    take: 5,
    select: {
      questionNum: true, syllabusTopic: true, answer: true,
      transcribedStem: true, transcribedOptions: true,
      yStartPct: true, yEndPct: true, pageIndex: true,
    },
  });
  console.log(`First 5 questions of ${qs.length}:\n`);
  for (const q of qs) {
    console.log(`Q${q.questionNum} [${q.syllabusTopic}]  page ${q.pageIndex} y=${q.yStartPct}-${q.yEndPct}`);
    console.log(`  stem: ${(q.transcribedStem ?? "(none)").slice(0, 200)}`);
    if (q.transcribedOptions) console.log(`  options: ${JSON.stringify(q.transcribedOptions).slice(0, 200)}`);
    console.log(`  answer: ${q.answer}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
