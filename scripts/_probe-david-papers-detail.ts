import { prisma } from "../src/lib/db";
(async () => {
  const davids = await prisma.user.findMany({
    where: { name: { contains: "david lim", mode: "insensitive" } },
    select: { id: true },
  });
  const ids = davids.map(d => d.id);
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: ids },
      title: { contains: "Revision", mode: "insensitive" },
    },
    select: {
      id: true, title: true, subject: true, paperType: true,
      isRevision: true, score: true, totalMarks: true,
      completedAt: true, createdAt: true,
      metadata: true,
    },
    orderBy: { createdAt: "asc" },
  });
  for (const p of papers) {
    const md = p.metadata as Record<string, unknown> | null;
    const sourceKind =
      md?.revisionMode ? `revisionMode=${JSON.stringify(md.revisionMode)}` :
      md?.masterClassSlug ? `masterClassSlug=${md.masterClassSlug}` :
      md?.classifiedBy ? `classifiedBy=${md.classifiedBy}` :
      md?.source ? `source=${md.source}` :
      "(no source hint)";
    console.log(`\n${p.id}`);
    console.log(`  title:        ${p.title}`);
    console.log(`  subject:      ${p.subject}`);
    console.log(`  paperType:    ${p.paperType}`);
    console.log(`  isRevision:   ${p.isRevision}`);
    console.log(`  score:        ${p.score}/${p.totalMarks}`);
    console.log(`  createdAt:    ${p.createdAt.toISOString()}`);
    console.log(`  completedAt:  ${p.completedAt?.toISOString() ?? "(none)"}`);
    console.log(`  source hint:  ${sourceKind}`);
    if (md) {
      const interestingKeys = Object.keys(md).filter(k =>
        ["revisionMode", "masterClassSlug", "classifiedBy", "source", "mode", "kind", "type"].includes(k.toLowerCase())
        || k.toLowerCase().includes("revision")
        || k.toLowerCase().includes("master")
      );
      if (interestingKeys.length > 0) {
        console.log(`  metadata keys: ${interestingKeys.map(k => `${k}=${JSON.stringify((md as Record<string, unknown>)[k]).slice(0, 60)}`).join(", ")}`);
      }
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
