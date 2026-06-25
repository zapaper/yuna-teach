// POST /api/admin/compo/[id]/analyse — kick off the 4-stage pipeline
// (OCR -> wrong words -> critique -> recommendations). Fire-and-forget:
// returns 202 immediately, the orchestrator persists each stage to the
// DB as it lands. Re-runs are idempotent — the orchestrator flips
// status back to "analysing" and overwrites the AI-produced fields.

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { isSessionAdmin } from "@/lib/session";
import { analyseCompoAttempt } from "@/lib/compo-analysis";
import { prisma } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.compoAttempt.findUnique({ where: { id }, select: { id: true, status: true, updatedAt: true } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // 'analysing' usually means the orchestrator is actively walking
  // through the pipeline — block re-triggering to avoid two parallel
  // analyse() runs clobbering each other. BUT if updatedAt hasn't
  // moved in 5+ minutes, the orchestrator most likely died (Railway
  // redeploy killed the container, container OOM-killed mid-run,
  // crash on a Gemini timeout). In that case treat the row as
  // stuck and let the request re-kick the pipeline.
  if (row.status === "analysing") {
    const ageMs = Date.now() - row.updatedAt.getTime();
    const STUCK_MS = 5 * 60 * 1000;
    if (ageMs < STUCK_MS) {
      return NextResponse.json({
        error: "Already analysing",
        stuckEligibleInMs: STUCK_MS - ageMs,
      }, { status: 409 });
    }
    console.warn(`[compo:${id}] stuck recovery: status=analysing for ${Math.round(ageMs / 1000)}s — re-kicking pipeline`);
  }
  // Flip status SYNCHRONOUSLY before kicking off the orchestrator —
  // otherwise the detail page's status-conditional polling
  // (poll iff status ∈ {analysing, uploaded}) won't fire because
  // the row still looks "ready" until the orchestrator's first
  // async DB write lands. Re-analyse would appear to do nothing
  // until completion.
  //
  // ALSO clear the AI-produced fields so the progress tracker
  // resets to Stage 1/5. Without this, an already-ready row keeps
  // its old ocrText / wrongWords / critique / recommendations
  // until each stage of the new run overwrites them, and the
  // 'first unfilled field' tracker reads as Stage 5/5 throughout.
  await prisma.compoAttempt.update({
    where: { id },
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
  // Fire-and-forget. Errors land in the row's status=failed +
  // errorMessage by the orchestrator's own catch.
  analyseCompoAttempt(id).catch(err => {
    console.error(`[compo:${id}] background analyse threw:`, err);
  });
  return NextResponse.json({ ok: true, id }, { status: 202 });
}
