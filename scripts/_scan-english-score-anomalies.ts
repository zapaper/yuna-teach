// Scan English papers from the last N days (default 60) for any score
// anomaly worth a manual look:
//   1. mismatch — paper.score != SUM(per-question marks). The original
//      pre-11fe0464 bug. Should be 0 post-recovery, kept here as a
//      regression check.
//   2. zero-score — completed/released with score == 0 AND all
//      questions individually marked 0. Suspicious because a 0/N
//      result usually means either an answer-key/option shuffle bug
//      or the student gave up.
//   3. very-low — scorePct < 20% (well below struggle territory).
//      Could be a partial scan / mis-marked / real low performance.
//   4. failed — markingStatus="failed" papers that never recovered.
//   5. stuck — markingStatus="in_progress" past 5 min.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_scan-english-score-anomalies.ts [days=60]

import { prisma } from "../src/lib/db";

(async () => {
  const days = Number(process.argv[2] ?? 60);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  const stuckBefore = new Date(Date.now() - STUCK_THRESHOLD_MS);
  console.log(`Scanning English papers since ${since.toISOString().slice(0, 10)} (last ${days} days)\n`);

  // Exclude admin + test students from real-incident reporting.
  const all = await prisma.user.findMany({ select: { id: true, name: true, settings: true } });
  const excluded = new Set(all.filter(u => {
    const lower = (u.name ?? "").toLowerCase();
    if (lower === "admin" || lower === "student555" || lower === "student666") return true;
    return (u.settings as { admin?: unknown } | null)?.admin === true;
  }).map(u => u.id));

  const papers = await prisma.examPaper.findMany({
    where: {
      completedAt: { gte: since },
      paperType: { not: "eval" },
      subject: { contains: "english", mode: "insensitive" },
    },
    select: {
      id: true, title: true, paperType: true, subject: true,
      markingStatus: true, score: true, totalMarks: true,
      completedAt: true, userId: true, assignedToId: true,
      assignedTo: { select: { name: true } },
      user: { select: { name: true } },
      questions: {
        select: { marksAwarded: true, marksAvailable: true, studentAnswer: true },
      },
    },
    orderBy: { completedAt: "desc" },
  });

  type Row = {
    id: string; title: string; paperType: string | null;
    completedAt: string; owner: string;
    paperScore: number | null; sumAwarded: number; totalMarks: number | null;
    scorePct: number | null; marked: number; total: number;
    notes: string[];
  };
  const mismatches: Row[] = [];
  const zeroScore: Row[] = [];
  const veryLow: Row[] = [];
  const failed: Row[] = [];
  const stuck: Row[] = [];

  let realCount = 0;
  for (const p of papers) {
    // Skip test/admin owners for the public reporting buckets.
    const ownerId = p.assignedToId ?? p.userId;
    if (excluded.has(ownerId)) continue;
    realCount++;

    let aw = 0, marked = 0;
    let everyMarkedIsZero = true;
    let nonSkippedAttempted = 0;
    for (const q of p.questions) {
      const v = q.marksAwarded ?? null;
      if (v !== null) {
        marked++;
        aw += v;
        if (v > 0) everyMarkedIsZero = false;
      }
      if (q.studentAnswer && q.studentAnswer !== "__SKIPPED__") nonSkippedAttempted++;
    }
    const total = p.questions.length;
    const totalMarksNum = p.totalMarks ? Number(p.totalMarks) : NaN;
    const scorePct = (Number.isFinite(totalMarksNum) && totalMarksNum > 0 && p.score != null)
      ? Math.round((p.score / totalMarksNum) * 100) : null;
    const ownerName = p.assignedTo?.name ?? p.user?.name ?? "?";
    const row: Row = {
      id: p.id, title: p.title, paperType: p.paperType,
      completedAt: p.completedAt?.toISOString().slice(0, 19) ?? "?",
      owner: ownerName, paperScore: p.score,
      sumAwarded: aw, totalMarks: Number.isFinite(totalMarksNum) ? totalMarksNum : null,
      scorePct, marked, total, notes: [],
    };

    // 1. mismatch — should be empty post-recovery
    if (aw > 0 && p.score != null && Math.abs((p.score ?? 0) - aw) > 0.01) {
      row.notes.push(`paper.score=${p.score} but sum=${aw}`);
      mismatches.push(row);
    }
    // 2. zero-score — completed AND score 0 AND all marked = 0 AND student attempted
    if ((p.markingStatus === "complete" || p.markingStatus === "released")
        && p.score === 0 && total > 0 && marked === total && everyMarkedIsZero
        && nonSkippedAttempted > 0) {
      zeroScore.push(row);
    }
    // 3. very-low — completed and scorePct < 20%, nonzero score
    if ((p.markingStatus === "complete" || p.markingStatus === "released")
        && scorePct !== null && scorePct < 20 && (p.score ?? 0) > 0) {
      veryLow.push(row);
    }
    // 4. failed
    if (p.markingStatus === "failed") failed.push(row);
    // 5. stuck
    if (p.markingStatus === "in_progress" && p.completedAt && p.completedAt < stuckBefore) {
      stuck.push(row);
    }
  }

  console.log(`English papers in window (real users only): ${realCount}\n`);
  function dump(label: string, rows: Row[]) {
    console.log(`=== ${label}  (${rows.length}) ===`);
    if (rows.length === 0) { console.log(`  none\n`); return; }
    // Oldest first so longest-pending bubbles up.
    rows.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    for (const r of rows.slice(0, 50)) {
      const scoreCol = r.totalMarks != null ? `${r.paperScore}/${r.totalMarks}${r.scorePct != null ? ` (${r.scorePct}%)` : ""}` : `${r.paperScore}/?`;
      console.log(`  ${r.completedAt}  ${(r.paperType ?? "exam").padEnd(8)}  score=${scoreCol.padEnd(20)} ${r.marked}/${r.total}Q  by=${r.owner.padEnd(16)} "${r.title.slice(0, 40)}"  id=${r.id}`);
      if (r.notes.length > 0) console.log(`     notes: ${r.notes.join(" ; ")}`);
    }
    if (rows.length > 50) console.log(`  ... +${rows.length - 50} more`);
    console.log();
  }
  dump("MISMATCH (paper.score != sum)", mismatches);
  dump("ZERO SCORE (all marked 0, student attempted)", zeroScore);
  dump("VERY LOW (< 20%, nonzero)", veryLow);
  dump("FAILED (markingStatus=failed)", failed);
  dump("STUCK (in_progress > 5min)", stuck);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
