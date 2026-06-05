// POST /api/admin/see-answer-image/clear
// Body: { questionId: string }
// Sets seeAnswerImageCleared=true on that question so the sweep stops
// surfacing it. Admin-gated.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { questionId } = await request.json().catch(() => ({})) as { questionId?: string };
  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }
  try {
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { seeAnswerImageCleared: true },
    });
  } catch (err) {
    console.error(`[see-answer-image/clear] failed for ${questionId}:`, err);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
