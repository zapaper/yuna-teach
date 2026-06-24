// POST /api/admin/auto-remark-stuck
//
// Sweeps for papers whose marking didn't finish cleanly — typically
// because a Railway redeploy killed the marker worker mid-fetch — and
// re-triggers their marker. Idempotent: a paper that's already being
// re-marked when we check will be skipped on subsequent calls (status
// flips to "in_progress" the moment we re-trigger).
//
// What counts as "stuck":
//   · markingStatus="in_progress" AND completedAt is older than the
//     stuck threshold (5 min). The worker either died or genuinely
//     hung; either way the marker won't progress on its own.
//   · markingStatus="failed". With MAX_UNMARKED_FOR_CAVEAT=0, any
//     question the marker couldn't put a verdict on lands the whole
//     paper at "failed". A re-mark is the recovery path.
//
// What's intentionally NOT touched:
//   · markingStatus in {complete, released} — already done.
//   · markingStatus=null (paper never submitted) — nothing to mark.
//   · paperType not in {focused, mastery, quiz, null} — unknown shape.
//
// Auth: admin only. Intended to be called manually or by a Railway
// post-deploy hook. Returns the list of papers it re-triggered so the
// caller can log / surface.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { Prisma } from "@prisma/client";
import { markExamPaper, markQuizPaper, markFocusedTest } from "@/lib/marking";

const STUCK_IN_PROGRESS_MS = 5 * 60 * 1000;

export async function POST() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const now = Date.now();
  // 14 days back — matches the marking-dashboard window. Beyond that
  // re-marks are unlikely to be useful (kid has long since moved on),
  // and a wider window risks paging through too many ancient rows.
  const since = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const stuckCandidates = await prisma.examPaper.findMany({
    where: {
      OR: [
        { markingStatus: "in_progress", completedAt: { lt: new Date(now - STUCK_IN_PROGRESS_MS) } },
        { markingStatus: "failed", completedAt: { gte: since } },
      ],
    },
    select: { id: true, paperType: true, markingStatus: true, completedAt: true, title: true },
    orderBy: { completedAt: "desc" },
  });
  if (stuckCandidates.length === 0) {
    return NextResponse.json({ rescued: 0, papers: [] });
  }

  const rescued: Array<{ id: string; title: string; route: string; previousStatus: string }> = [];
  for (const p of stuckCandidates) {
    const route = await pickRoute(p.id, p.paperType);
    if (!route) {
      console.warn(`[auto-remark] ${p.id} — no route for paperType=${p.paperType}, skipping`);
      continue;
    }
    // Flip to in_progress first so a parent watching the dashboard
    // sees the card switch from failed/stuck to "marking…" immediately.
    await prisma.examPaper.update({
      where: { id: p.id },
      data: { markingStatus: "in_progress" },
    });
    rescued.push({ id: p.id, title: p.title, route, previousStatus: p.markingStatus ?? "(null)" });
    // Fire-and-forget — same shape as /api/exam/[id]/mark POST. Errors
    // are logged inside the marker; we don't await so a single hung
    // marker doesn't block the whole sweep.
    runMarker(p.id, route);
  }
  console.log(`[auto-remark] rescued ${rescued.length} paper(s):`, rescued.map(r => `${r.id} (${r.previousStatus} → ${r.route})`).join(", "));
  return NextResponse.json({ rescued: rescued.length, papers: rescued });
}

async function pickRoute(paperId: string, paperType: string | null): Promise<"focused" | "exam" | "quiz" | null> {
  if (paperType === "focused" || paperType === "mastery") return "focused";
  if (paperType === "quiz") {
    // Same printableBounds check the /mark POST does to distinguish a
    // typed quiz from a printed-and-scanned one.
    const printableCount = await prisma.examQuestion.count({
      where: { examPaperId: paperId, printableBounds: { not: Prisma.AnyNull } },
    });
    return printableCount > 0 ? "exam" : "quiz";
  }
  if (paperType === null) return "exam";
  return null;
}

function runMarker(paperId: string, route: "focused" | "exam" | "quiz") {
  const tag = `[auto-remark:${paperId.slice(-6)}]`;
  if (route === "focused") {
    markFocusedTest(paperId).catch(err => console.error(`${tag} markFocusedTest failed:`, err));
  } else if (route === "quiz") {
    markQuizPaper(paperId).catch(err => console.error(`${tag} markQuizPaper failed:`, err));
  } else {
    markExamPaper(paperId).catch(err => console.error(`${tag} markExamPaper failed:`, err));
  }
}
