// POST /api/admin/compo/[id]/analyse — kick off the 4-stage pipeline
// (OCR -> wrong words -> critique -> recommendations). Fire-and-forget:
// returns 202 immediately, the orchestrator persists each stage to the
// DB as it lands. Re-runs are idempotent — the orchestrator flips
// status back to "analysing" and overwrites the AI-produced fields.

import { NextRequest, NextResponse } from "next/server";
import { isSessionAdmin } from "@/lib/session";
import { analyseCompoAttempt } from "@/lib/compo-analysis";
import { prisma } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.compoAttempt.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status === "analysing") {
    return NextResponse.json({ error: "Already analysing" }, { status: 409 });
  }
  // Fire-and-forget. Errors land in the row's status=failed +
  // errorMessage by the orchestrator's own catch.
  analyseCompoAttempt(id).catch(err => {
    console.error(`[compo:${id}] background analyse threw:`, err);
  });
  return NextResponse.json({ ok: true, id }, { status: 202 });
}
