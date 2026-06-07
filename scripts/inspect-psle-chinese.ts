// Quick inspection: list every PSLE Chinese paper and the
// syllabusTopic distribution across its questions.

import { prisma } from "../src/lib/db";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: {
      id: true,
      title: true,
      year: true,
      level: true,
      subject: true,
      _count: { select: { questions: true } },
    },
    orderBy: { year: "desc" },
  });

  console.log(`Found ${papers.length} PSLE Chinese papers:`);
  for (const p of papers) {
    console.log(`  ${p.year ?? "?"}  ${p.title}  (subject="${p.subject}", level="${p.level}", ${p._count.questions} questions)`);
  }

  if (papers.length === 0) {
    console.log("\nNo PSLE Chinese papers found via title/level. Trying broader chinese-subject search...");
    const broader = await prisma.examPaper.findMany({
      where: {
        subject: { contains: "chinese", mode: "insensitive" },
        sourceExamId: null,
        paperType: null,
      },
      select: { id: true, title: true, year: true, level: true, subject: true, _count: { select: { questions: true } } },
      orderBy: { year: "desc" },
      take: 30,
    });
    for (const p of broader) {
      console.log(`  ${p.year ?? "?"}  ${p.title}  (subject="${p.subject}", level="${p.level}", ${p._count.questions} questions)`);
    }
  }

  // syllabusTopic distribution across the matched PSLE Chinese papers
  if (papers.length > 0) {
    const paperIds = papers.map(p => p.id);
    const topics = await prisma.examQuestion.groupBy({
      by: ["syllabusTopic"],
      where: { examPaperId: { in: paperIds } },
      _count: { _all: true },
    });
    console.log(`\nsyllabusTopic distribution across these papers:`);
    for (const t of topics.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${t._count._all.toString().padStart(4)}  ${t.syllabusTopic ?? "(null)"}`);
    }
  }

  await prisma.$disconnect();
})();
