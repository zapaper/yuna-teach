import { prisma } from "../src/lib/db";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      NOT: { title: { startsWith: "Test Quiz" } },
      AND: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { title: { contains: "english", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, year: true, subject: true },
    orderBy: { title: "asc" },
  });
  console.log(`Found ${papers.length} PSLE English masters:`);
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { syllabusTopic: true, marksAvailable: true },
    });
    const byTopic = new Map<string, number>();
    for (const q of qs) {
      const t = q.syllabusTopic ?? "(no topic)";
      byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
    }
    console.log(`\n  ${p.title}  (${qs.length} qs)`);
    for (const [t, n] of [...byTopic.entries()].sort()) {
      console.log(`    ${n.toString().padStart(3)}  ${t}`);
    }
  }
  await prisma.$disconnect();
})();
