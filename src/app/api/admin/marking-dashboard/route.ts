// Marking dashboard data — submission volume + stuck/failed/anomaly
// detection. Read-only; admins can act on individual papers via the
// existing /api/exam/[id]/mark endpoint.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// "Stuck" = markingStatus is in_progress AND completedAt is older
// than this. A typical full mark on a busy paper finishes in ~60s;
// 5 min is generous enough that we don't false-positive an actively
// running marker.
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve excluded test/admin user ids.
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, settings: true },
  });
  const excludedIds: string[] = [];
  for (const u of allUsers) {
    const lower = (u.name ?? "").toLowerCase();
    if (lower === "admin" || EXCLUDED_NAMES.has(lower)) { excludedIds.push(u.id); continue; }
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) excludedIds.push(u.id);
  }

  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const userScope = excludedIds.length > 0 ? {
    AND: [
      { userId: { notIn: excludedIds } },
      { OR: [{ assignedToId: null }, { assignedToId: { notIn: excludedIds } }] },
    ],
  } : {};

  // Pull the slim window once and aggregate in memory — 7d window is
  // small (< few hundred rows) and we want flexible per-hour / per-day
  // buckets the DB groupBy can't do cleanly across timezones.
  const recent = await prisma.examPaper.findMany({
    where: {
      completedAt: { gte: since7d },
      paperType: { not: "eval" },
      ...userScope,
    },
    select: {
      id: true,
      title: true,
      subject: true,
      paperType: true,
      markingStatus: true,
      completedAt: true,
      updatedAt: true,
      score: true,
      totalMarks: true,
      assignedTo: { select: { id: true, name: true } },
      user: { select: { id: true, name: true } },
      _count: { select: { questions: true } },
    },
    orderBy: { completedAt: "desc" },
  });

  // SGT (UTC+8) buckets — bucket keys are "YYYY-MM-DD HH" for hourly
  // and "YYYY-MM-DD" for daily, computed against +08:00 so the chart
  // matches local clock time.
  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  function sgtParts(d: Date): { dateKey: string; hourKey: string; ymd: string; hour: number } {
    const shifted = new Date(d.getTime() + SGT_OFFSET_MS);
    const yyyy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(shifted.getUTCDate()).padStart(2, "0");
    const hh = String(shifted.getUTCHours()).padStart(2, "0");
    const ymd = `${yyyy}-${mm}-${dd}`;
    return { dateKey: ymd, hourKey: `${ymd} ${hh}:00`, ymd, hour: shifted.getUTCHours() };
  }

  // Hourly volume — last 24h. Initialise every hour bucket so the
  // chart isn't gapped on quiet hours.
  const hourly: Array<{ bucket: string; total: number; complete: number; failed: number; inProgress: number; stuck: number }> = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(now - i * 60 * 60 * 1000);
    const { hourKey } = sgtParts(t);
    hourly.push({ bucket: hourKey, total: 0, complete: 0, failed: 0, inProgress: 0, stuck: 0 });
  }
  const hourIdx = new Map(hourly.map((h, i) => [h.bucket, i]));

  // Daily volume — last 7 days.
  const daily: Array<{ bucket: string; total: number; complete: number; failed: number; inProgress: number; stuck: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(now - i * 24 * 60 * 60 * 1000);
    const { dateKey } = sgtParts(t);
    daily.push({ bucket: dateKey, total: 0, complete: 0, failed: 0, inProgress: 0, stuck: 0 });
  }
  const dayIdx = new Map(daily.map((d, i) => [d.bucket, i]));

  type Anomaly = {
    id: string;
    title: string;
    subject: string | null;
    paperType: string | null;
    completedAt: string;
    ageMin: number;
    markingStatus: string | null;
    ownerName: string | null;
    ownerId: string | null;
    studentName: string | null;
    studentId: string | null;
    parentName: string | null;
    parentId: string | null;
    score: number | null;
    totalMarks: string | null;
    scorePct: number | null;
    questionCount: number;
    markedCount?: number;
    reason: "failed" | "stuck" | "complete-zero-marked" | "low-score" | "zero-score";
  };
  const failed: Anomaly[] = [];
  const stuck: Anomaly[] = [];
  const zeroMarked: Anomaly[] = [];
  // Score-based anomalies — split into two buckets so the admin can
  // triage: zero scores almost always mean a scan/marker failure
  // (student wrote something but nothing was detected); low-but-non-
  // zero scores are likelier to be genuine "this kid is struggling".
  const zeroScore: Anomaly[] = [];
  const lowScore: Anomaly[] = [];
  // Threshold: under 30% of total marks. PSLE pass is typically 50%,
  // so under 30% is well below struggle territory and worth a look.
  const LOW_SCORE_THRESHOLD_PCT = 30;

  // Resolve student → parent map for any assigned papers. Parent of a
  // student lives in ParentStudent; we pull them in one batch so the
  // anomaly rows can show "<student> (parent <name>)" without N+1 hits.
  const studentIds = new Set<string>();
  for (const p of recent) if (p.assignedTo?.id) studentIds.add(p.assignedTo.id);
  const parentLinks = studentIds.size > 0 ? await prisma.parentStudent.findMany({
    where: { studentId: { in: [...studentIds] } },
    select: { studentId: true, parent: { select: { id: true, name: true } } },
  }) : [];
  const parentOfStudent = new Map<string, { id: string; name: string }>();
  for (const pl of parentLinks) {
    // First-write-wins — a student with multiple parents only shows the
    // first one in the badge; clicking through reveals the rest.
    if (!parentOfStudent.has(pl.studentId)) parentOfStudent.set(pl.studentId, pl.parent);
  }

  // Pre-resolve "complete with 0 marks marked" rows: query the count
  // in a separate batch on just the candidates.
  const completeCandidates = recent.filter(
    (p) => (p.markingStatus === "complete" || p.markingStatus === "released") && p._count.questions > 0
  );
  const markedCounts = new Map<string, number>();
  if (completeCandidates.length > 0) {
    const counts = await prisma.examQuestion.groupBy({
      by: ["examPaperId"],
      where: {
        examPaperId: { in: completeCandidates.map((p) => p.id) },
        marksAwarded: { not: null },
      },
      _count: { _all: true },
    });
    for (const c of counts) markedCounts.set(c.examPaperId, c._count._all);
  }

  for (const p of recent) {
    if (!p.completedAt) continue;
    const { hourKey, dateKey } = sgtParts(p.completedAt);
    const ageMin = Math.round((now - p.completedAt.getTime()) / 60000);
    const isStuck = p.markingStatus === "in_progress" && now - p.completedAt.getTime() > STUCK_THRESHOLD_MS;

    const tickBucket = (bucket: { total: number; complete: number; failed: number; inProgress: number; stuck: number }) => {
      bucket.total++;
      if (p.markingStatus === "failed") bucket.failed++;
      else if (p.markingStatus === "in_progress") {
        bucket.inProgress++;
        if (isStuck) bucket.stuck++;
      } else if (p.markingStatus === "complete" || p.markingStatus === "released") bucket.complete++;
    };
    const hIdx = hourIdx.get(hourKey);
    if (hIdx !== undefined) tickBucket(hourly[hIdx]);
    const dIdx = dayIdx.get(dateKey);
    if (dIdx !== undefined) tickBucket(daily[dIdx]);

    const owner = p.assignedTo ?? p.user;
    const student = p.assignedTo ?? null;
    const parent = (student && parentOfStudent.get(student.id)) ?? p.user ?? null;
    const totalMarksNum = p.totalMarks ? Number(p.totalMarks) : NaN;
    const scorePct = (Number.isFinite(totalMarksNum) && totalMarksNum > 0 && p.score != null)
      ? Math.round((p.score / totalMarksNum) * 100)
      : null;
    const baseAnomaly: Anomaly = {
      id: p.id,
      title: p.title,
      subject: p.subject,
      paperType: p.paperType,
      completedAt: p.completedAt.toISOString(),
      ageMin,
      markingStatus: p.markingStatus,
      ownerName: owner?.name ?? null,
      ownerId: owner?.id ?? null,
      studentName: student?.name ?? null,
      studentId: student?.id ?? null,
      parentName: parent?.name ?? null,
      parentId: parent?.id ?? null,
      score: p.score,
      totalMarks: p.totalMarks,
      scorePct,
      questionCount: p._count.questions,
      reason: "failed",
    };
    if (p.markingStatus === "failed") {
      failed.push(baseAnomaly);
    } else if (isStuck) {
      stuck.push({ ...baseAnomaly, reason: "stuck" });
    } else if ((p.markingStatus === "complete" || p.markingStatus === "released") && p._count.questions > 0) {
      const marked = markedCounts.get(p.id) ?? 0;
      if (marked === 0) {
        zeroMarked.push({ ...baseAnomaly, reason: "complete-zero-marked", markedCount: 0 });
      }
      // Score-based anomalies — only look at completed/released papers
      // (in-flight scores are unreliable). Skip when totalMarks is
      // unparseable (legacy rows) or score is still null.
      if (Number.isFinite(totalMarksNum) && totalMarksNum > 0 && p.score != null) {
        if (p.score === 0) {
          zeroScore.push({ ...baseAnomaly, reason: "zero-score" });
        } else if (scorePct !== null && scorePct < LOW_SCORE_THRESHOLD_PCT) {
          lowScore.push({ ...baseAnomaly, reason: "low-score" });
        }
      }
    }
  }
  // Sort low/zero score lists by oldest first so the admin sees the
  // longest-unaddressed first.
  zeroScore.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  lowScore.sort((a, b) => (a.scorePct ?? 100) - (b.scorePct ?? 100));

  // Totals row across the 7d window.
  const totals = {
    total: recent.length,
    complete: recent.filter((p) => p.markingStatus === "complete" || p.markingStatus === "released").length,
    failed: failed.length,
    stuck: stuck.length,
    zeroMarked: zeroMarked.length,
    inProgress: recent.filter((p) => p.markingStatus === "in_progress" && !stuck.some((s) => s.id === p.id)).length,
    zeroScore: zeroScore.length,
    lowScore: lowScore.length,
  };

  return NextResponse.json({
    now: new Date(now).toISOString(),
    tz: "Asia/Singapore (UTC+8)",
    hourly,
    daily,
    totals,
    lowScoreThresholdPct: LOW_SCORE_THRESHOLD_PCT,
    anomalies: { failed, stuck, zeroMarked, zeroScore, lowScore },
  });
}
