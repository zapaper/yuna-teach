// Delete David lim's Master Class revision papers (paperType=
// "mastery-review"). These are the per-class "revision" papers the
// student can do after going through a Master Class — David has 9 of
// them mostly with score=null (created but never completed) plus one
// with 0/41 score, and they're cluttering his dashboard + skewing
// any subject average that doesn't filter them out.
//
// We intentionally DO NOT touch:
//   - paperType="mastery" (the actual Master Class quizzes he did
//     and scored on — those are legitimate practice)
//   - paperType="quiz" with isRevision=true (the proper
//     student-revision papers from /api/admin/student-revision —
//     user explicitly said "the proper revisions are ok")
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

  // ONLY paperType="mastery-review" — the Master Class revision
  // papers. Excludes plain "mastery" (the master-class quizzes
  // themselves) and excludes "quiz" with isRevision=true (proper
  // student-revision papers).
  const candidates = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: davidIds },
      paperType: "mastery-review",
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
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nMaster Class revision papers assigned to David lim (${candidates.length}):`);
  for (const p of candidates) {
    console.log(`  ${p.completedAt?.toISOString().slice(0, 10) ?? "(never finished)"}  ${(p.subject ?? "?").padEnd(20)}  score=${p.score}/${p.totalMarks ?? "?"}  ${p._count.questions}Q  "${p.title.slice(0, 50)}"  id=${p.id}`);
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
