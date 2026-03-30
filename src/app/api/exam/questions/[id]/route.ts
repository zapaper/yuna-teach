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
  if ("pageIndex" in body) data.pageIndex = body.pageIndex;
  if ("yStartPct" in body) data.yStartPct = body.yStartPct ?? null;
  if ("yEndPct" in body) data.yEndPct = body.yEndPct ?? null;
  if ("answer" in body) data.answer = body.answer ?? null;
  if ("imageData" in body) data.imageData = body.imageData;
  if ("answerImageData" in body) data.answerImageData = body.answerImageData ?? null;
  if ("marksAwarded" in body) data.marksAwarded = body.marksAwarded ?? null;
  if ("marksAvailable" in body) data.marksAvailable = body.marksAvailable ?? null;
  if ("markingNotes" in body) data.markingNotes = body.markingNotes ?? null;
  if ("syllabusTopic" in body) data.syllabusTopic = body.syllabusTopic ?? null;
  if ("studentAnswer" in body) data.studentAnswer = body.studentAnswer ?? null;
  if ("elaboration" in body) data.elaboration = body.elaboration ?? null;

  let question;
  try {
    question = await prisma.examQuestion.update({
      where: { id },
      data,
      include: { examPaper: { include: { questions: { select: { marksAwarded: true } } } } },
    });
  } catch (err: unknown) {
    console.error("[questions PATCH] error for id:", id, "fields:", Object.keys(data), err);
    if (err && typeof err === "object" && "code" in err && err.code === "P2025") {
      return NextResponse.json({ error: "Question not found" }, { status: 404 });
    }
    throw err;
  }

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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  await prisma.examQuestion.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
