// Inventory PSLE Chinese papers in the DB across 2016-2025.
// Look for Paper 1 / Paper 2 / Paper 3 (oral) split or single combined paper.

import { prisma } from "../src/lib/db";

async function main() {
  const all = await prisma.examPaper.findMany({
    where: {
      OR: [
        { subject: { contains: "chinese", mode: "insensitive" } },
        { title: { contains: "chinese", mode: "insensitive" } },
        { title: { contains: "华文" } },
        { title: { contains: "中文" } },
      ],
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: {
      id: true,
      title: true,
      year: true,
      level: true,
      subject: true,
      paperType: true,
      sourceExamId: true,
      _count: { select: { questions: true } },
    },
    orderBy: [{ year: "desc" }, { title: "asc" }],
    take: 100,
  });

  // Only the master/library rows (no sourceExamId, no paperType-quiz clones).
  const masters = all.filter(p => !p.sourceExamId && (p.paperType === null || p.paperType === undefined));

  console.log(`Total PSLE Chinese rows: ${all.length}, masters (no clones): ${masters.length}\n`);
  console.log("year\ttitle\t#qs\tid");
  for (const m of masters) {
    console.log(`${m.year}\t${m.title}\t${m._count.questions}\t${m.id}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
