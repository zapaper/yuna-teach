// Scan for completed/released papers whose paper.score doesn't match
// the per-question sum, then optionally fix them.
//
// Root cause: pre-11fe0464 (Jun 4 2026) routing bug sent typed
// English MCQ quizzes to markExamPaper, which never wrote
// paper.score even though per-question MCQ marks landed correctly.
// Bug is fixed for new submissions; this script recovers historical
// ones.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_recover-score-mismatch.ts             # dry-run, just report
//   DATABASE_URL=... npx tsx scripts/_recover-score-mismatch.ts --apply     # actually fix

import { prisma } from "../src/lib/db";

(async () => {
  const apply = process.argv.includes("--apply");

  // All completed/released papers in the system. We aggregate marks
  // in code instead of relying on a SQL join because the per-question
  // counts are small and we want to surface the full context.
  const papers = await prisma.examPaper.findMany({
    where: {
      markingStatus: { in: ["complete", "released"] },
      paperType: { not: "eval" },
    },
    select: {
      id: true, title: true, subject: true, paperType: true,
      markingStatus: true, score: true, totalMarks: true,
      completedAt: true,
      assignedTo: { select: { name: true } },
      user: { select: { name: true } },
      questions: {
        select: { marksAwarded: true, marksAvailable: true },
      },
    },
  });

  type Mismatch = {
    id: string;
    title: string;
    subject: string | null;
    paperType: string | null;
    completedAt: string | null;
    owner: string | null;
    paperScore: number | null;
    sumAwarded: number;
    sumAvailable: number;
    markedQuestions: number;
    totalQuestions: number;
  };
  const mismatches: Mismatch[] = [];

  for (const p of papers) {
    let aw = 0, av = 0, marked = 0;
    for (const q of p.questions) {
      aw += q.marksAwarded ?? 0;
      av += q.marksAvailable ?? 0;
      if (q.marksAwarded !== null) marked++;
    }
    // Score mismatch when:
    //   - the SUM of per-question awards > 0 AND
    //   - paper.score is null OR clearly different from the sum
    // We tolerate tiny floating diffs (0.01) because half-mark adds.
    const stored = p.score ?? 0;
    if (aw > 0 && Math.abs(stored - aw) > 0.01) {
      mismatches.push({
        id: p.id,
        title: p.title,
        subject: p.subject,
        paperType: p.paperType,
        completedAt: p.completedAt?.toISOString() ?? null,
        owner: p.assignedTo?.name ?? p.user?.name ?? null,
        paperScore: p.score,
        sumAwarded: aw,
        sumAvailable: av,
        markedQuestions: marked,
        totalQuestions: p.questions.length,
      });
    }
  }

  console.log(`Scanned ${papers.length} completed/released papers.`);
  console.log(`Found ${mismatches.length} with score mismatch (paper.score != sum of per-question marks).\n`);

  // Group by month/subject so the pattern is visible.
  const bySubject = new Map<string, number>();
  for (const m of mismatches) {
    const k = m.subject ?? "(unknown)";
    bySubject.set(k, (bySubject.get(k) ?? 0) + 1);
  }
  console.log("By subject:");
  for (const [s, n] of [...bySubject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(30)} ${n}`);
  }

  // Print a sample of the first 20 so the user can spot-check.
  console.log("\nFirst 20 mismatches (oldest first):");
  const sample = [...mismatches].sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "")).slice(0, 20);
  for (const m of sample) {
    console.log(`  ${m.completedAt?.slice(0, 10) ?? "?"}  ${(m.subject ?? "?").padEnd(20)}  ${(m.paperType ?? "exam").padEnd(8)}  paper.score=${String(m.paperScore).padEnd(4)} → should be ${m.sumAwarded.toString().padEnd(4)} / ${m.sumAvailable}  by=${m.owner ?? "?"}  "${m.title.slice(0, 40)}"`);
  }

  if (!apply) {
    console.log(`\nDry run. Pass --apply to actually update paper.score.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nApplying fixes…`);
  // Use a transaction per paper rather than one giant transaction so
  // a single bad row doesn't roll back the entire recovery.
  let ok = 0, failed = 0;
  for (const m of mismatches) {
    try {
      await prisma.examPaper.update({
        where: { id: m.id },
        data: { score: m.sumAwarded },
      });
      ok++;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${m.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${ok} fixed, ${failed} failed.`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
