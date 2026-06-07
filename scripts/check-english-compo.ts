import { prisma } from "../src/lib/db";
async function main() {
  // PSLE English papers in DB
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "english", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, title: true, year: true, pageCount: true, _count: { select: { questions: true } } },
    orderBy: { year: "desc" },
    take: 20,
  });
  console.log(`PSLE English master papers in DB: ${papers.length}`);
  for (const p of papers) console.log(`  ${p.year}\t${p.title}\t${p.pageCount}p\t${p._count.questions} qs`);

  // Composition data? Look for composition supplementary table
  const compoTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%english%compo%' OR table_name ILIKE '%composition%')`,
  );
  console.log(`\nEnglish composition tables: ${JSON.stringify(compoTables)}`);

  // PSLE English papers on disk
  const fs = await import("fs");
  const path = await import("path");
  try {
    const files = await fs.promises.readdir("c:/Users/peter/Yuna teach/Data Past Year Papers/PSLE English");
    console.log(`\nPSLE English PDFs on disk:`);
    files.filter(f => /^\d{4}.*\.pdf$/i.test(f)).forEach(f => console.log(`  ${f}`));
  } catch (e) {
    console.log(`\n(PSLE English folder not found: ${(e as Error).message.slice(0, 80)})`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
