// POST /api/admin/compo/batch-analyse/save
//
// Persists a cross-essay coaching summary so the admin can re-open it
// later without re-running Gemini. Each saved row gets surfaced on the
// detail page of any covered CompoAttempt as an expandable
// "Lumi's tip (N essays)" card.
//
// Request body:
//   { attemptIds: string[], analysis: BatchAnalyseResult }
//
// We re-derive language + studentId on the server (don't trust the
// client) so the index queries on (studentId, language) stay clean.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as {
    attemptIds?: unknown;
    analysis?: unknown;
  };
  const attemptIds = Array.isArray(body.attemptIds)
    ? body.attemptIds.filter((x): x is string => typeof x === "string")
    : [];
  if (attemptIds.length < 2) {
    return NextResponse.json({ error: "Need at least 2 attempt ids" }, { status: 400 });
  }
  if (typeof body.analysis !== "object" || body.analysis === null) {
    return NextResponse.json({ error: "analysis must be an object" }, { status: 400 });
  }

  // Pull the covered attempts so we can derive studentId + language
  // ourselves. Saves us trusting the client for fields the schema
  // indexes on.
  const attempts = await prisma.compoAttempt.findMany({
    where: { id: { in: attemptIds } },
    select: { id: true, studentId: true, language: true },
  });
  if (attempts.length === 0) {
    return NextResponse.json({ error: "no matching attempts" }, { status: 404 });
  }
  // If every covered attempt belongs to the same student, save the
  // tip scoped to that student. Mixed-student batches save with
  // studentId = null (admin-pool tip).
  const studentIds = new Set(attempts.map(a => a.studentId).filter((x): x is string => !!x));
  const studentId = studentIds.size === 1 ? [...studentIds][0]! : null;

  const langs = new Set(attempts.map(a => (a.language ?? "chinese").toLowerCase()));
  const language = langs.size === 1 ? [...langs][0]! : "mixed";

  const savedById = await getSessionUserId();

  const tip = await prisma.batchCoachTip.create({
    data: {
      studentId,
      savedById,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attemptIds: attemptIds as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      analysis: body.analysis as any,
      language,
    },
    select: { id: true, createdAt: true },
  });
  return NextResponse.json({ id: tip.id, createdAt: tip.createdAt });
}
