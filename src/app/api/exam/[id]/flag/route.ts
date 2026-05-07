import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/exam/[id]/flag
// Body: { questionId, userId, text? }
//   text — optional typed note ("alternative to the voice-note flow).
//          Saved verbatim on the row. Trimmed; >800 chars rejected so
//          the column doesn't grow into a free-form complaint inbox.
// Toggles the flagged status of a question. When unflagging, both
// flagText and flagVoiceNote are cleared so the next flag starts
// fresh.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json()) as { questionId?: string; userId?: string; text?: string };
  const { questionId, userId } = body;
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }
  if (text.length > 800) {
    return NextResponse.json({ error: "text too long" }, { status: 400 });
  }

  const question = await prisma.examQuestion.findFirst({
    where: { id: questionId, examPaperId: id },
    select: { flagged: true },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  const nowFlagged = !question.flagged;

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: {
      flagged: nowFlagged,
      flaggedAt: nowFlagged ? new Date() : null,
      flaggedByUserId: nowFlagged ? (userId || null) : null,
      // Persist the typed note when raising a flag with text. Wipe both
      // flagText and flagVoiceNote when toggling the flag off so the
      // next flag attempt isn't polluted by stale notes.
      flagText: nowFlagged ? (text.length > 0 ? text : null) : null,
      flagVoiceNote: nowFlagged ? undefined : null,
    },
  });

  return NextResponse.json({ flagged: nowFlagged });
}
