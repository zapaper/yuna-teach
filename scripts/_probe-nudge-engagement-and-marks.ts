// Two analytics questions in one probe:
//   1. Of all kids who received the Day-3 activation nudge (the auto-
//      assigned Grammar+Vocab English MCQ Daily Quiz), how many have
//      actually attempted that quiz (or any English quiz since the
//      nudge)?
//   2. Total marks attempted across the app — i.e. sum of marksAvailable
//      across every marked ExamQuestion (excluding eval + revision-mode).
//
// Run: npx tsx scripts/_probe-nudge-engagement-and-marks.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // ─── Q1: nudge engagement ────────────────────────────────────────
  // Pull every kid with settings.activationNudgeSent set. Use JSON path
  // filter so we don't scan the entire user table.
  const nudged = await prisma.$queryRaw<Array<{ id: string; name: string; sent_at: string }>>`
    SELECT id, name, "settings"->>'activationNudgeSent' AS sent_at
    FROM users
    WHERE "settings" ? 'activationNudgeSent'
      AND "settings"->>'activationNudgeSent' IS NOT NULL
      AND "settings"->>'activationNudgeSent' <> 'false'
  `;
  console.log(`Nudge sends recorded (settings.activationNudgeSent set): ${nudged.length}`);
  if (nudged.length === 0) return;

  const nudgeTimes = new Map<string, Date>();
  for (const n of nudged) {
    const d = new Date(n.sent_at);
    if (!isNaN(d.getTime())) nudgeTimes.set(n.id, d);
  }
  console.log(`  (with parseable timestamp): ${nudgeTimes.size}`);
  const earliest = [...nudgeTimes.values()].sort((a, b) => a.getTime() - b.getTime())[0];
  console.log(`  earliest nudge: ${earliest?.toISOString() ?? "n/a"}`);

  // For each nudged kid, count English papers attempted AT OR AFTER
  // the nudge timestamp. "Attempted" = the paper has at least one
  // question with marksAwarded != null (so partial / submitted counts).
  const allPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: [...nudgeTimes.keys()] },
      subject: { contains: "english", mode: "insensitive" },
      NOT: { paperType: "eval" },
    },
    select: {
      assignedToId: true,
      createdAt: true,
      markingStatus: true,
      metadata: true,
      questions: { select: { marksAwarded: true }, take: 1 },
    },
  });

  const stats = {
    anyEnglishAttempted: 0,
    notAttempted: 0,
    anyEnglishMarked: 0,
  };
  const byKid = new Map<string, { attempted: boolean; marked: boolean }>();
  for (const [kid] of nudgeTimes) byKid.set(kid, { attempted: false, marked: false });
  for (const p of allPapers) {
    if (!p.assignedToId) continue;
    const sentAt = nudgeTimes.get(p.assignedToId);
    if (!sentAt) continue;
    // Only papers created AT or AFTER the nudge (the nudge cron creates
    // the paper milliseconds before logging the send timestamp; use a
    // 1-minute slack so we don't miss the auto-created paper).
    const slackMs = 60 * 1000;
    if (p.createdAt.getTime() + slackMs < sentAt.getTime()) continue;
    // Drop revision-mode clones.
    const meta = (p.metadata ?? {}) as { revisionMode?: string };
    if (meta.revisionMode) continue;
    const cur = byKid.get(p.assignedToId)!;
    if (p.questions[0]?.marksAwarded != null) cur.attempted = true;
    if (p.markingStatus === "complete" || p.markingStatus === "released") cur.marked = true;
  }
  for (const v of byKid.values()) {
    if (v.attempted) stats.anyEnglishAttempted++;
    else stats.notAttempted++;
    if (v.marked) stats.anyEnglishMarked++;
  }
  console.log(`\nOf ${byKid.size} nudged kids:`);
  console.log(`  ${stats.anyEnglishAttempted} attempted at least one English question after the nudge (${Math.round(stats.anyEnglishAttempted / byKid.size * 100)}%)`);
  console.log(`  ${stats.anyEnglishMarked} had at least one English paper reach marked/released status (${Math.round(stats.anyEnglishMarked / byKid.size * 100)}%)`);
  console.log(`  ${stats.notAttempted} did NOT attempt any English question since the nudge`);

  // ─── Q2: total marks attempted across the app ───────────────────
  // Sum marksAvailable for every ExamQuestion where the parent paper is
  // marked complete/released, excluding eval + revision-mode papers.
  // marksAvailable not null + gt 0 ensures we don't count un-mark-keyed
  // blanks. This is the universe of "questions the app has scored".
  console.log(`\nQ2: total marks attempted across the app`);
  const agg = await prisma.examQuestion.aggregate({
    where: {
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      examPaper: {
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
    },
    _sum: { marksAvailable: true, marksAwarded: true },
    _count: { _all: true },
  });
  // Subtract revision-mode contribution via a JS filter (Prisma can't
  // filter on examPaper.metadata.revisionMode without a custom path).
  const revisionPapers = await prisma.examPaper.findMany({
    where: { markingStatus: { in: ["complete", "released"] }, NOT: { paperType: "eval" } },
    select: { id: true, metadata: true },
  });
  const revisionIds = revisionPapers
    .filter(p => (p.metadata as { revisionMode?: string } | null)?.revisionMode)
    .map(p => p.id);
  let revAvailable = 0, revAwarded = 0, revCount = 0;
  if (revisionIds.length > 0) {
    const revAgg = await prisma.examQuestion.aggregate({
      where: {
        marksAwarded: { not: null },
        marksAvailable: { not: null, gt: 0 },
        examPaperId: { in: revisionIds },
      },
      _sum: { marksAvailable: true, marksAwarded: true },
      _count: { _all: true },
    });
    revAvailable = revAgg._sum.marksAvailable ?? 0;
    revAwarded = revAgg._sum.marksAwarded ?? 0;
    revCount = revAgg._count._all;
  }
  const totalAvailable = (agg._sum.marksAvailable ?? 0) - revAvailable;
  const totalAwarded   = (agg._sum.marksAwarded   ?? 0) - revAwarded;
  const totalCount     = (agg._count._all          ) - revCount;
  console.log(`  total questions marked: ${totalCount.toLocaleString()}`);
  console.log(`  total marks available:  ${totalAvailable.toLocaleString()}`);
  console.log(`  total marks awarded:    ${totalAwarded.toLocaleString()}`);
  console.log(`  overall accuracy:       ${totalAvailable > 0 ? ((totalAwarded / totalAvailable) * 100).toFixed(1) : "n/a"}%`);
  console.log(`  (excluded: ${revisionIds.length} revision-mode papers contributing ${revCount.toLocaleString()} qs, ${revAvailable.toLocaleString()} marks)`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
