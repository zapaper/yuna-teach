// List quizzes / focused / exam papers that were submitted in the
// last N days (default 3) and report their marking status. Surfaces
// any paper where the marker explicitly failed, never started, or
// stalled in_progress longer than expected.
//
// Excludes admin + the test student accounts so we only see real
// learner activity.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_recent-marking-failures.ts [days=3]

import { prisma } from "../src/lib/db";

const EXCLUDED_NAMES = new Set(["student555", "student666", "admin"]);

(async () => {
  const days = Number(process.argv[2] ?? 3);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(`Looking at submissions since ${since.toISOString()} (last ${days} day(s))`);

  // Resolve excluded user ids.
  const all = await prisma.user.findMany({
    select: { id: true, name: true, settings: true },
  });
  const excluded = all.filter((u) => {
    const lower = (u.name ?? "").toLowerCase();
    if (lower === "admin") return true;
    if (EXCLUDED_NAMES.has(lower)) return true;
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) return true;
    return false;
  });
  const excludedIds = excluded.map((u) => u.id);
  console.log(`Excluding ${excluded.length} test/admin accounts`);

  // Pull every paper with completedAt in window.
  const papers = await prisma.examPaper.findMany({
    where: {
      completedAt: { gte: since },
      // Skip eval clones (ours, not real learners).
      paperType: { not: "eval" },
      ...(excludedIds.length > 0
        ? {
            AND: [
              { userId: { notIn: excludedIds } },
              { OR: [{ assignedToId: null }, { assignedToId: { notIn: excludedIds } }] },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      subject: true,
      paperType: true,
      markingStatus: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      score: true,
      totalMarks: true,
      assignedTo: { select: { name: true } },
      user: { select: { name: true } },
      _count: { select: { questions: true } },
    },
    orderBy: { completedAt: "desc" },
  });

  // Bucket by markingStatus.
  type Row = (typeof papers)[number];
  const byStatus = new Map<string, Row[]>();
  for (const p of papers) {
    const key = p.markingStatus ?? "(null)";
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key)!.push(p);
  }

  console.log(`\nTotal submissions in window: ${papers.length}`);
  console.log(`By markingStatus:`);
  for (const [status, list] of [...byStatus.entries()].sort()) {
    console.log(`  ${status.padEnd(15)} ${list.length}`);
  }

  // FAILED — any explicit fail.
  const failed = byStatus.get("failed") ?? [];
  if (failed.length > 0) {
    console.log(`\n=== FAILED (${failed.length}) ===`);
    for (const p of failed) {
      const owner = p.assignedTo?.name ?? p.user?.name ?? "?";
      console.log(`  ${p.completedAt?.toISOString().slice(0, 19)}  ${p.subject ?? "?"}/${p.paperType ?? "exam"}  "${p.title}"  by=${owner}`);
      console.log(`    id=${p.id}  score=${p.score}/${p.totalMarks ?? "?"}  questions=${p._count.questions}`);
    }
  } else {
    console.log(`\nNo papers with markingStatus="failed" in window.`);
  }

  // STUCK in_progress — marker started but never wrote a final state.
  // Anything in_progress >30 min after completedAt is almost certainly
  // dead (Railway container restart, OOM, unhandled exception).
  const STUCK_THRESHOLD_MS = 30 * 60 * 1000;
  const stuck = (byStatus.get("in_progress") ?? []).filter((p) => {
    if (!p.completedAt) return false;
    return Date.now() - p.completedAt.getTime() > STUCK_THRESHOLD_MS;
  });
  if (stuck.length > 0) {
    console.log(`\n=== STUCK in_progress >30min (${stuck.length}) ===`);
    for (const p of stuck) {
      const owner = p.assignedTo?.name ?? p.user?.name ?? "?";
      const ageMin = p.completedAt ? Math.round((Date.now() - p.completedAt.getTime()) / 60000) : "?";
      console.log(`  ${p.completedAt?.toISOString().slice(0, 19)}  ${p.subject ?? "?"}/${p.paperType ?? "exam"}  "${p.title}"  by=${owner}  age=${ageMin}min`);
      console.log(`    id=${p.id}  questions=${p._count.questions}`);
    }
  }

  // Marked but no marksAwarded on any question — silent fail.
  // Marker says "complete" but every question is unmarked.
  const completedNoMarks: Array<{ p: Row; markedQ: number }> = [];
  for (const p of papers) {
    if (p.markingStatus !== "complete" && p.markingStatus !== "released") continue;
    const markedQ = await prisma.examQuestion.count({
      where: { examPaperId: p.id, marksAwarded: { not: null } },
    });
    if (markedQ === 0 && p._count.questions > 0) {
      completedNoMarks.push({ p, markedQ });
    }
  }
  if (completedNoMarks.length > 0) {
    console.log(`\n=== complete/released but ZERO questions marked (${completedNoMarks.length}) ===`);
    for (const { p } of completedNoMarks) {
      const owner = p.assignedTo?.name ?? p.user?.name ?? "?";
      console.log(`  ${p.completedAt?.toISOString().slice(0, 19)}  ${p.subject ?? "?"}/${p.paperType ?? "exam"}  "${p.title}"  by=${owner}`);
      console.log(`    id=${p.id}  status=${p.markingStatus}  questions=${p._count.questions}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
