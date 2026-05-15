import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST { questionId } → marks the question as skipped in the
// MCQ → Table conversion tool so it never reappears in the
// candidate list. Persists across rescans / sessions.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { questionId } = await request.json();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });
  try {
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { mcqTableSkipped: true },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[mcq-table-candidates/skip] failed", err);
    return NextResponse.json({ error: "Skip failed" }, { status: 500 });
  }
}
