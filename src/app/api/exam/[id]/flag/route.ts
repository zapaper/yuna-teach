import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// POST /api/exam/[id]/flag
// Body: { questionId, userId, text?, action? }
//   text   — optional typed note (alternative to the voice-note flow).
//            Saved verbatim on the row. Trimmed; >800 chars rejected
//            so the column doesn't grow into a free-form complaint
//            inbox.
//   action — optional explicit intent ("flag" | "unflag"). Defaults
//            to "toggle" (legacy behaviour) when omitted. The admin
//            Flagged Q&A page sends "unflag" on trash-icon delete so
//            a between-load-and-click race (kid unflags first) can't
//            silently re-flag the question.
// When unflagging, both flagText and flagVoiceNote are cleared so the
// next flag starts fresh.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json()) as { questionId?: string; userId?: string; text?: string; action?: string };
  const { questionId } = body;
  // Fall back to the session-cookie userId when the client doesn't
  // send one. The 3 flag callers (quiz, review, overview) all read
  // userId from the URL search param — if a parent / admin lands on
  // a flag UI from a path that lacks ?userId=, the body.userId is
  // empty and the flag previously stored null. That hides the +1
  // crystal toggle on the admin flagged-Q&A page (the toggle gates
  // on flaggedByUserId). Session fallback keeps every flag from a
  // logged-in user attributed.
  const userId = (body.userId && body.userId.length > 0)
    ? body.userId
    : (await getSessionUserId() ?? null);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const action = body.action === "flag" || body.action === "unflag" ? body.action : null;

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

  const nowFlagged = action === "flag" ? true : action === "unflag" ? false : !question.flagged;

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
