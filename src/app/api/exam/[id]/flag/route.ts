import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/exam/[id]/flag
// Body: { questionId, userId }
// Toggles the flagged status of a question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { questionId, userId } = await request.json();

  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
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
    },
  });

  return NextResponse.json({ flagged: nowFlagged });
}
