// One-off cleanup: deletes the 218 [EVAL] paperType clones that
// accumulated before the eval-script default was flipped to
// cleanup=true. These rows live against real students' userIds but
// aren't real practice, and were silently padding Lumi + progress
// queries (David Lim's Human Respiratory inflated 30 → 240).
//
// Safety:
//   · Strictly filters by paperType === "eval" — never touches real
//     practice papers.
//   · Cascade rule on ExamQuestion (relation onDelete: Cascade) drops
//     the clone's questions automatically.
//   · Filesystem JPGs under VOLUME_PATH/submissions/<paperId>/ are
//     left in place — they're on the Railway volume which this
//     local script can't reach. If you want them gone, run a follow-up
//     cleanup on the Railway shell.
//
// Run once:
//   npx tsx scripts/_delete-eval-clones-backlog.ts          (dry run — list IDs)
//   npx tsx scripts/_delete-eval-clones-backlog.ts --apply  (perform delete)

import { prisma } from "../src/lib/db";

const apply = process.argv.includes("--apply");

(async () => {
  const evalPapers = await prisma.examPaper.findMany({
    where: { paperType: "eval" },
    select: {
      id: true, title: true, subject: true, completedAt: true,
      assignedTo: { select: { name: true } },
      _count: { select: { questions: true } },
    },
    orderBy: { completedAt: "desc" },
  });
  console.log(`Found ${evalPapers.length} [EVAL] paperType rows.`);
  if (evalPapers.length === 0) { await prisma.$disconnect(); return; }

  // Per-student summary so it's clear what's being touched.
  const byKid = new Map<string, number>();
  let questionCount = 0;
  for (const p of evalPapers) {
    const name = p.assignedTo?.name ?? "(unknown)";
    byKid.set(name, (byKid.get(name) ?? 0) + 1);
    questionCount += p._count.questions;
  }
  console.log(`Total cloned questions to drop (via cascade): ${questionCount}`);
  console.log("\nBy student:");
  for (const [name, n] of [...byKid.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(28)} ${n} clones`);
  }

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to perform the delete.");
    await prisma.$disconnect();
    return;
  }

  console.log("\nDeleting…");
  // Batch by ID list — Prisma's deleteMany handles the WHERE filter
  // directly, ExamQuestion cascade rule drops the child rows.
  const ids = evalPapers.map(p => p.id);
  const result = await prisma.examPaper.deleteMany({ where: { id: { in: ids } } });
  console.log(`Deleted ${result.count} rows.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
