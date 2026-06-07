import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { subject: { contains: "chinese", mode: "insensitive" } },
        { subject: { contains: "华文" } },
        { subject: { contains: "中文" } },
        { subject: { contains: "华语" } },
      ],
    },
    select: {
      id: true, title: true, subject: true, paperType: true,
      sourceExamId: true, pdfPath: true, assignedToId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log(`Found ${papers.length} Chinese papers (most recent 30):`);
  for (const p of papers) {
    console.log(`  ${p.createdAt.toISOString().slice(0,10)} ${p.id} type=${p.paperType ?? "(master)"} pdf=${p.pdfPath ? "✓" : "✗"} src=${p.sourceExamId ? p.sourceExamId.slice(0, 8) + "…" : "—"} student=${p.assignedToId ? "yes" : "no"} title="${p.title.slice(0, 50)}"`);
  }
  // Pull masters without pdfPath specifically.
  const mastersNoPdf = papers.filter(p => p.sourceExamId === null && p.pdfPath === null);
  if (mastersNoPdf.length > 0) {
    console.log(`\n⚠️  ${mastersNoPdf.length} Chinese MASTER paper(s) have NO pdfPath:`);
    for (const p of mastersNoPdf) console.log(`    ${p.id} "${p.title}"`);
  }
  // For clones, walk to master and check master pdfPath.
  const clones = papers.filter(p => p.sourceExamId !== null);
  if (clones.length > 0) {
    const srcIds = [...new Set(clones.map(c => c.sourceExamId).filter((x): x is string => !!x))];
    const sources = await prisma.examPaper.findMany({
      where: { id: { in: srcIds } },
      select: { id: true, pdfPath: true, title: true },
    });
    const byId = new Map(sources.map(s => [s.id, s]));
    const orphans = clones.filter(c => {
      const src = c.sourceExamId ? byId.get(c.sourceExamId) : null;
      return !src || !src.pdfPath;
    });
    if (orphans.length > 0) {
      console.log(`\n⚠️  ${orphans.length} Chinese CLONE(s) have NO usable pdfPath (master missing PDF):`);
      for (const c of orphans) {
        const src = c.sourceExamId ? byId.get(c.sourceExamId) : null;
        console.log(`    clone=${c.id} student=${c.assignedToId ? "yes" : "no"} source=${src?.id ?? "missing"} source.pdf=${src?.pdfPath ? "✓" : "✗"} title="${c.title.slice(0, 50)}"`);
      }
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
