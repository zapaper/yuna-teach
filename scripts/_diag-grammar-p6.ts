// Diagnose why master Grammar MCQ count on P6 looks low. Audit how
// P6 English master papers tag their grammar questions.

import { prisma } from "../src/lib/db";

async function main() {
  // 1. All master English papers tagged as P6 (any flavour).
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "english", mode: "insensitive" },
      OR: [
        { level: { contains: "Primary 6", mode: "insensitive" } },
        { level: { equals: "P6", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, level: true, year: true },
  });
  console.log(`P6/PSLE master English papers: ${papers.length}`);
  for (const p of papers.slice(0, 30)) {
    console.log(`  level="${p.level}"  year=${p.year}  ${p.title.slice(0, 70)}`);
  }
  if (papers.length > 30) console.log(`  …and ${papers.length - 30} more`);

  // 2. Per-paper syllabusTopic distribution — what's tagged where?
  console.log(`\nsyllabusTopic distribution across these papers:`);
  const ids = papers.map(p => p.id);
  const topics = await prisma.examQuestion.groupBy({
    by: ["syllabusTopic"],
    where: { examPaperId: { in: ids } },
    _count: { _all: true },
  });
  for (const t of topics.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${(t.syllabusTopic ?? "(null)").padEnd(35)} ${t._count._all}`);
  }

  // 3. Is the level being normalised? Show all distinct level values
  // on English master papers, to confirm we're not missing a label
  // (e.g. "Primary Six" or "Pri 6").
  console.log(`\nAll distinct level values on master English papers:`);
  const lvls = await prisma.examPaper.findMany({
    where: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } },
    select: { level: true },
    distinct: ["level"],
  });
  for (const l of lvls) console.log(`  "${l.level ?? "(null)"}"`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
