import { prisma } from "../src/lib/db";
(async () => {
  const ids = ['cmopbiv5c007e1amhebuzllkm','cmopbgwc100581amhoj9xijop','cmop85sny00011amhpayg3m9a','cmop6v11k000dzzemrpbmtcv0','cmop670hk0001rx698kid1xy1','cmop5qh3s003i8hfvltsofeo1','cmop1l4sb0001amba50yeecxs'];
  const ps = await prisma.examPaper.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, completedAt: true, markingStatus: true, score: true, metadata: true, _count: { select: { questions: true } } } });
  for (const p of ps) {
    const meta = p.metadata as { revisionMode?: string } | null;
    console.log(`${p.id} | ${p.title} | mode=${meta?.revisionMode} | qs=${p._count.questions} | done=${p.completedAt ? "yes" : "no"} | marking=${p.markingStatus} | score=${p.score}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
