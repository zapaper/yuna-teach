// Shared recovery sweeps for work that didn't finish cleanly —
// typically because a Railway redeploy killed the worker container
// mid-pipeline. Both an HTTP route (admin-triggered) and the
// instrumentation startup hook (auto-trigger on fresh deploy) call
// these so a redeploy automatically recovers in-flight work.
//
// Two sweeps live here:
//   1. recoverStuckCompo()  — CompoAttempt rows where the analyse
//      pipeline stalled (status="analysing" + idle ≥ 5 min) or
//      previously failed (within 14 days).
//   2. recoverStuckExamMarking() — ExamPaper rows where the marker
//      stalled (markingStatus="in_progress" + idle ≥ 5 min) or
//      previously failed (within 14 days). Mirrors what
//      /api/admin/auto-remark-stuck has always done — just exposed
//      as a callable so the instrumentation hook can reuse it
//      without an HTTP round-trip.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { analyseCompoAttempt } from "@/lib/compo-analysis";
import { markExamPaper, markQuizPaper, markFocusedTest } from "@/lib/marking";

const STUCK_MS = 5 * 60 * 1000;             // 5 min idle = presumed dead
const FAILED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 d back for failed-state retries

export type CompoRecoverySummary = {
  rescued: number;
  attempts: Array<{
    id: string;
    label: string | null;
    previousStatus: string;
    idleSeconds: number;
  }>;
};

export async function recoverStuckCompo(): Promise<CompoRecoverySummary> {
  const now = Date.now();
  const stuckThreshold = new Date(now - STUCK_MS);
  const failedSince = new Date(now - FAILED_LOOKBACK_MS);

  const candidates = await prisma.compoAttempt.findMany({
    where: {
      OR: [
        { status: "analysing", updatedAt: { lt: stuckThreshold } },
        { status: "failed", updatedAt: { gte: failedSince } },
      ],
    },
    select: { id: true, label: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  if (candidates.length === 0) return { rescued: 0, attempts: [] };

  const attempts: CompoRecoverySummary["attempts"] = [];
  for (const a of candidates) {
    // Same clear-and-flip the /analyse endpoint does on re-kick:
    // null the prior run's AI fields so the detail-page tracker
    // reads as Stage 1/5 again.
    await prisma.compoAttempt.update({
      where: { id: a.id },
      data: {
        status: "analysing",
        errorMessage: null,
        ocrText: null,
        ocrQuestionText: null,
        wrongWords: Prisma.DbNull,
        critique: Prisma.DbNull,
        recommendations: Prisma.DbNull,
      },
    });
    attempts.push({
      id: a.id,
      label: a.label,
      previousStatus: a.status,
      idleSeconds: Math.round((now - a.updatedAt.getTime()) / 1000),
    });
    // Fire-and-forget — errors land in the row's status=failed +
    // errorMessage via the orchestrator's own catch.
    analyseCompoAttempt(a.id).catch(err => {
      console.error(`[stuck-recovery:compo:${a.id.slice(-6)}] background analyse threw:`, err);
    });
  }
  console.log(
    `[stuck-recovery:compo] rescued ${attempts.length} attempt(s):`,
    attempts.map(r => `${r.id} (${r.previousStatus} ${r.idleSeconds}s)`).join(", "),
  );
  return { rescued: attempts.length, attempts };
}

export type ExamRecoverySummary = {
  rescued: number;
  papers: Array<{ id: string; title: string; route: string; previousStatus: string }>;
};

async function pickExamMarkRoute(
  paperId: string,
  paperType: string | null,
): Promise<"focused" | "exam" | "quiz" | null> {
  if (paperType === "focused" || paperType === "mastery") return "focused";
  if (paperType === "quiz") {
    const printableCount = await prisma.examQuestion.count({
      where: { examPaperId: paperId, printableBounds: { not: Prisma.AnyNull } },
    });
    return printableCount > 0 ? "exam" : "quiz";
  }
  if (paperType === null) return "exam";
  return null;
}

function fireExamMarker(paperId: string, route: "focused" | "exam" | "quiz") {
  const tag = `[stuck-recovery:exam:${paperId.slice(-6)}]`;
  if (route === "focused") {
    markFocusedTest(paperId).catch(err => console.error(`${tag} markFocusedTest failed:`, err));
  } else if (route === "quiz") {
    markQuizPaper(paperId).catch(err => console.error(`${tag} markQuizPaper failed:`, err));
  } else {
    markExamPaper(paperId).catch(err => console.error(`${tag} markExamPaper failed:`, err));
  }
}

export async function recoverStuckExamMarking(): Promise<ExamRecoverySummary> {
  const now = Date.now();
  const stuckThreshold = new Date(now - STUCK_MS);
  const since = new Date(now - FAILED_LOOKBACK_MS);

  const candidates = await prisma.examPaper.findMany({
    where: {
      OR: [
        { markingStatus: "in_progress", completedAt: { lt: stuckThreshold } },
        { markingStatus: "failed", completedAt: { gte: since } },
      ],
    },
    select: { id: true, title: true, paperType: true, markingStatus: true, completedAt: true },
    orderBy: { completedAt: "desc" },
  });
  if (candidates.length === 0) return { rescued: 0, papers: [] };

  const rescued: ExamRecoverySummary["papers"] = [];
  for (const p of candidates) {
    const route = await pickExamMarkRoute(p.id, p.paperType);
    if (!route) {
      console.warn(`[stuck-recovery:exam] ${p.id} — no route for paperType=${p.paperType}, skipping`);
      continue;
    }
    await prisma.examPaper.update({
      where: { id: p.id },
      data: { markingStatus: "in_progress" },
    });
    rescued.push({ id: p.id, title: p.title, route, previousStatus: p.markingStatus ?? "(null)" });
    fireExamMarker(p.id, route);
  }
  console.log(
    `[stuck-recovery:exam] rescued ${rescued.length} paper(s):`,
    rescued.map(r => `${r.id} (${r.previousStatus} → ${r.route})`).join(", "),
  );
  return { rescued: rescued.length, papers: rescued };
}
