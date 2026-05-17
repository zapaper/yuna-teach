import { prisma } from "../src/lib/db";
(async () => {
  const studentId = process.argv[2];
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
      subject: { contains: "english", mode: "insensitive" },
    },
    orderBy: { completedAt: "desc" },
    take: 30,
    select: { id: true, title: true, completedAt: true, paperType: true, metadata: true, _count: { select: { questions: true } } },
  });
  for (const p of papers) {
    const meta = p.metadata as { revisionMode?: string } | null;
    console.log(`${p.id}  ${p.completedAt!.toISOString().slice(0,16)}  type=${p.paperType}  rev=${meta?.revisionMode ?? "no"}  qs=${p._count.questions}  "${p.title}"`);
  }
  await prisma.$disconnect();
})();
