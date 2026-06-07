import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      NOT: { title: { startsWith: "Test Quiz" } },
      AND: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { title: { contains: "science", mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      title: true,
      year: true,
      subject: true,
      _count: { select: { questions: true } },
    },
    orderBy: { title: "asc" },
  });
  console.log(`Found ${papers.length} PSLE Science master papers:\n`);
  for (const p of papers) {
    console.log(`  ${p.id}  ${p.year ?? "—".padEnd(20)}  qs=${String(p._count.questions).padStart(3)}  ${p.title}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
