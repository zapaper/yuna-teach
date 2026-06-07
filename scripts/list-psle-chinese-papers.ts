import { prisma } from "../src/lib/db";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "chinese", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: { id: true, title: true, year: true, pageCount: true, _count: { select: { questions: true } } },
    orderBy: { title: "asc" },
  });
  console.log(`Found ${papers.length} PSLE Chinese papers:`);
  for (const p of papers) {
    console.log(`  year=${p.year ?? "—"}  ${p._count.questions}Q  ${p.pageCount}pp  "${p.title}"  (${p.id})`);
  }
  await prisma.$disconnect();
})();
