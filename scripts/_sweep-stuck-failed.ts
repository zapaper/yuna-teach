// Find every paper currently markingStatus=failed where the marks
// actually committed (all questions have marksAwarded set, sum matches
// paper.score). Report only — no writes unless --apply is passed.

import { prisma } from "../src/lib/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const papers = await prisma.examPaper.findMany({
    where: { markingStatus: "failed" },
    select: { id: true, title: true, score: true, totalMarks: true, paperType: true, assignedToId: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`scanning ${papers.length} failed-status papers`);

  const fixable: { id: string; title: string; score: number | null; sum: number }[] = [];
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { marksAwarded: true },
    });
    if (qs.length === 0) continue;
    const nullCount = qs.filter(q => q.marksAwarded == null).length;
    if (nullCount > 0) continue;
    const sum = qs.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    if (Math.abs(sum - (p.score ?? -1)) > 0.001) continue;
    fixable.push({ id: p.id, title: p.title, score: p.score, sum });
  }

  console.log(`\n${fixable.length} papers are fully marked but stuck on status=failed:`);
  for (const f of fixable) {
    console.log(`  ${f.id}  ${f.score}/?  ${f.title.slice(0, 70)}`);
  }

  if (!apply) {
    console.log(`\n(report only — pass --apply to flip them to "complete")`);
    return;
  }
  if (fixable.length === 0) { console.log("nothing to apply"); return; }
  await prisma.$transaction(
    fixable.map(f => prisma.examPaper.update({
      where: { id: f.id }, data: { markingStatus: "complete" },
    }))
  );
  console.log(`\n✓ flipped ${fixable.length} papers to status="complete"`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
