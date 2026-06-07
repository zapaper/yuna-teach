import { prisma } from "../src/lib/db";

(async () => {
  const titles = [
    "P6 Life Science MCQ 2022-2024",
    "PSLE Physical Science MCQ 2022-2024",
    "PSLE Life Science OEQ 2022-2024",
    "PSLE Physical science OEQ 2022-2024",
  ];
  for (const t of titles) {
    const paper = await prisma.examPaper.findFirst({
      where: { sourceExamId: null, title: t },
      select: { id: true, pageCount: true, metadata: true },
    });
    if (!paper) continue;
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id },
      select: { questionNum: true, pageIndex: true },
      orderBy: { orderIndex: "asc" },
    });
    const byPage = new Map<number, string[]>();
    for (const q of qs) {
      const arr = byPage.get(q.pageIndex) ?? [];
      arr.push(q.questionNum);
      byPage.set(q.pageIndex, arr);
    }
    console.log(t);
    console.log(`  pageCount: ${paper.pageCount}, ${qs.length} questions`);
    for (const [p, nums] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    page ${p}: ${nums.length} qs  [${nums.join(", ")}]`);
    }
    console.log();
  }
  await prisma.$disconnect();
})();
