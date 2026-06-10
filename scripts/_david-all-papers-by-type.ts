import { prisma } from "../src/lib/db";
(async () => {
  const davids = await prisma.user.findMany({
    where: { name: { contains: "david lim", mode: "insensitive" } },
    select: { id: true },
  });
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: { in: davids.map(d => d.id) } },
    select: {
      id: true, title: true, paperType: true, subject: true,
      score: true, totalMarks: true, completedAt: true, isRevision: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const byType = new Map<string, typeof papers>();
  for (const p of papers) {
    const k = `${p.paperType ?? "null"}${p.isRevision ? " [revision]" : ""}`;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k)!.push(p);
  }
  for (const [type, list] of byType.entries()) {
    console.log(`\n=== ${type}  (${list.length}) ===`);
    for (const p of list.slice(0, 15)) {
      const date = p.completedAt?.toISOString().slice(0, 10) ?? "?";
      console.log(`  ${date}  ${(p.subject ?? "?").padEnd(20)}  score=${p.score}/${p.totalMarks ?? "?"}  "${p.title.slice(0, 40)}"`);
    }
    if (list.length > 15) console.log(`  ...+${list.length - 15} more`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
