import { prisma } from "../src/lib/db";
(async () => {
  const ids = ["cmosevrtb00016r3v4a4le3vc", "cmosdqo390001wh2406pl8o44", "cmop5llyg002e8hfvhv0vfoce", "cmop5kv79001a8hfv8kwvaj1v", "cmop5f7pb00018hfvmhh2htr5"];
  const ps = await prisma.examPaper.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, completedAt: true, visible: true, createdAt: true, updatedAt: true, assignedToId: true, _count: { select: { questions: true } } } });
  for (const p of ps) {
    console.log(`${p.id}  visible=${p.visible}  qs=${p._count.questions}  completed=${p.completedAt?.toISOString().slice(0,16) ?? "no"}  updated=${p.updatedAt.toISOString().slice(0,16)}`);
    console.log(`  "${p.title}"`);
  }
  await prisma.$disconnect();
})();
