import { prisma } from "../src/lib/db";
(async () => {
  const recent = await prisma.examPaper.findMany({
    where: {
      paperType: "quiz",
      title: { contains: "Revision" },
    },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true, title: true, score: true, totalMarks: true, createdAt: true,
      _count: { select: { questions: true } },
      assignedTo: { select: { name: true } },
    },
  });
  for (const p of recent) {
    console.log(`${p.id}  qs=${p._count.questions}  score=${p.score}/${p.totalMarks}  ${p.createdAt.toISOString().slice(0,16)}`);
    console.log(`  "${p.title}"  for ${p.assignedTo?.name}`);
  }
  await prisma.$disconnect();
})();
