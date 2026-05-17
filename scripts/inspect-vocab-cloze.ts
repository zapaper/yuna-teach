import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = "cmp6jzwpt000s9mwusgh9lyng";
  const paper = await prisma.examPaper.findUnique({ where: { id: PAPER_ID }, select: { title: true } });
  console.log("Paper:", paper?.title);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { contains: "ocab" } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, syllabusTopic: true, transcribedStem: true, transcribedOptions: true, answer: true },
  });
  console.log(`${qs.length} vocab questions:\n`);
  for (const q of qs) {
    console.log(`=== Q${q.questionNum} · ${q.syllabusTopic} ===`);
    console.log(`stem: ${q.transcribedStem?.slice(0, 300) ?? "(none)"}`);
    if (q.transcribedOptions) console.log(`options: ${JSON.stringify(q.transcribedOptions).slice(0, 200)}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
