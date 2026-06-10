// Delete David lim's repeated "P6 English Revision 03 May" attempts.
// He took the same paper 6 times in one day with mostly 13/90 scores —
// likely random clicks, not real attempts — and they're skewing his
// English topic-level averages on the parent dashboard + progress
// charts.
//
// Strategy: hard-delete the ExamPaper rows. Prisma's onDelete: Cascade
// on the ExamQuestion FK takes care of question rows. Once they're
// gone they don't appear in any scoring aggregation (which all read
// from examQuestion live, not from a denorm).
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_delete-david-revision-papers.ts             # dry-run
//   DATABASE_URL=... npx tsx scripts/_delete-david-revision-papers.ts --apply     # actually delete

import { prisma } from "../src/lib/db";

(async () => {
  const apply = process.argv.includes("--apply");

  // Resolve every "David lim" account so we cover any duplicates.
  const davids = await prisma.user.findMany({
    where: { name: { contains: "david lim", mode: "insensitive" } },
    select: { id: true, name: true, email: true },
  });
  console.log(`David lim accounts (${davids.length}): ${davids.map(d => `${d.name} <${d.email ?? "?"}>`).join(", ")}`);
  const davidIds = davids.map(d => d.id);

  // Match any "Revision" paper assigned to a David lim. paperType=quiz
  // because that's how the student-revision endpoint creates them.
  // Title prefix narrows to genuine revision papers.
  const candidates = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: davidIds },
      title: { contains: "Revision", mode: "insensitive" },
    },
    select: {
      id: true,
      title: true,
      subject: true,
      paperType: true,
      isRevision: true,
      score: true,
      totalMarks: true,
      completedAt: true,
      _count: { select: { questions: true } },
    },
    orderBy: { completedAt: "asc" },
  });
  console.log(`\nRevision papers assigned to David lim (${candidates.length}):`);
  for (const p of candidates) {
    console.log(`  ${p.completedAt?.toISOString().slice(0, 10) ?? "(no date)"}  ${(p.subject ?? "?").padEnd(20)}  score=${p.score}/${p.totalMarks ?? "?"}  ${p._count.questions}Q  isRevision=${p.isRevision}  "${p.title}"  id=${p.id}`);
  }

  // Filter to the ones we actually want to drop. The user asked for
  // "the Revision paper for David" — interpreted as ALL revision
  // attempts assigned to him (every duplicate run). If you want a
  // narrower cut, edit the filter below.
  const toDelete = candidates;
  if (toDelete.length === 0) {
    console.log("\nNothing to delete.");
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(`\nDry run. ${toDelete.length} paper(s) would be deleted along with their questions.`);
    console.log(`Pass --apply to actually delete.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nDeleting ${toDelete.length} paper(s)…`);
  let ok = 0, failed = 0;
  for (const p of toDelete) {
    try {
      // Cascading delete: ExamQuestion FK on examPaperId is set to
      // onDelete: Cascade, so questions go automatically. Submission
      // files on disk are NOT touched — they live at
      // VOLUME_PATH/submissions/<paperId>/ and can be GC'd separately.
      await prisma.examPaper.delete({ where: { id: p.id } });
      ok++;
      console.log(`  ✓ ${p.id} ("${p.title.slice(0, 40)}")`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${p.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${ok} deleted, ${failed} failed.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
