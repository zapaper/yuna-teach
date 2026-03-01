import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  if ("questionNum" in body) data.questionNum = body.questionNum;
  if ("answer" in body) data.answer = body.answer ?? null;
  if ("imageData" in body) data.imageData = body.imageData;
  if ("answerImageData" in body) data.answerImageData = body.answerImageData ?? null;
  if ("marksAwarded" in body) data.marksAwarded = body.marksAwarded ?? null;
  if ("markingNotes" in body) data.markingNotes = body.markingNotes ?? null;

  const question = await prisma.examQuestion.update({
    where: { id },
    data,
    include: { examPaper: { include: { questions: { select: { marksAwarded: true } } } } },
  });

  // If marks changed, recalculate paper total score
  if ("marksAwarded" in body) {
    const total = question.examPaper.questions.reduce(
      (sum, q) => sum + (q.marksAwarded ?? 0),
      0
    );
    await prisma.examPaper.update({
      where: { id: question.examPaperId },
      data: { score: total },
    });
  }

  return NextResponse.json({ success: true, id: question.id });
}
