import { prisma } from "../src/lib/db";
(async () => {
  const all = await prisma.examPaper.findMany({
    where: { paperType: "quiz", title: { contains: "Revision" } },
    select: { id: true, title: true, score: true, metadata: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const r of all) {
    const meta = JSON.stringify(r.metadata);
    console.log(`${r.id}  ${r.title}  score=${r.score}  meta=${meta}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
