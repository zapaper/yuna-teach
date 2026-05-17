import { prisma } from "../src/lib/db";
(async () => {
  const all = await prisma.examPaper.findMany({
    where: { paperType: "quiz", title: { contains: "Revision" } },
    select: { id: true, title: true, score: true, metadata: true },
  });
  let cleared = 0;
  for (const p of all) {
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode !== "review") continue;
    if (p.score == null) continue;
    await prisma.examPaper.update({ where: { id: p.id }, data: { score: null } });
    cleared++;
    console.log(`  cleared ${p.id}  ${p.title}  was=${p.score}`);
  }
  console.log(`\nDone. ${cleared} papers updated.`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
