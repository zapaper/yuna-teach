import { prisma } from "../src/lib/db";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, answer: true, syllabusTopic: true },
  });
  // Find consecutive duplicates by (pageIndex, yStartPct, yEndPct)
  console.log("Looking for adjacent questions with identical y-bounds…\n");
  let issues = 0;
  for (let i = 1; i < qs.length; i++) {
    const a = qs[i - 1];
    const b = qs[i];
    if (a.pageIndex === b.pageIndex && a.yStartPct === b.yStartPct && a.yEndPct === b.yEndPct) {
      console.log(`  Q${a.questionNum} & Q${b.questionNum}: page=${a.pageIndex} y=${a.yStartPct}-${a.yEndPct}`);
      console.log(`    Q${a.questionNum} answer="${(a.answer ?? "").slice(0, 60)}" (${a.syllabusTopic})`);
      console.log(`    Q${b.questionNum} answer="${(b.answer ?? "").slice(0, 60)}" (${b.syllabusTopic})`);
      issues++;
    }
  }
  console.log(`\nTotal pairs with identical bounds: ${issues}`);
  process.exit(0);
}
main();
