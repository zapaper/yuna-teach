// POST /api/essay-coach/[id]/analyse — kick the analyse pipeline for
// an attempt the caller uploaded. Same fire-and-forget shape as the
// admin route.

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import { analyseCompoAttempt } from "@/lib/compo-analysis";
import { prisma } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const row = await prisma.compoAttempt.findUnique({
    where: { id },
    select: { id: true, status: true, updatedAt: true, uploaderId: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!auth.isAdmin && row.uploaderId !== auth.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Block parallel runs unless the existing one looks stuck (>5min
  // without an update — likely worker died). Mirrors admin route.
  if (row.status === "analysing") {
    const ageMs = Date.now() - row.updatedAt.getTime();
    const STUCK_MS = 5 * 60 * 1000;
    if (ageMs < STUCK_MS) {
      return NextResponse.json({
        error: "Already analysing",
        stuckEligibleInMs: STUCK_MS - ageMs,
      }, { status: 409 });
    }
    console.warn(`[essay-coach:${id}] stuck recovery: status=analysing for ${Math.round(ageMs / 1000)}s — re-kicking pipeline`);
  }
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
  analyseCompoAttempt(id).catch(err => {
    console.error(`[essay-coach:${id}] background analyse threw:`, err);
  });
  return NextResponse.json({ ok: true, id }, { status: 202 });
}
