import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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
  if ("transcribedStem" in body) data.transcribedStem = body.transcribedStem ?? null;
  if ("transcribedOptions" in body) data.transcribedOptions = body.transcribedOptions === null ? Prisma.DbNull : body.transcribedOptions;
  if ("transcribedSubparts" in body) data.transcribedSubparts = body.transcribedSubparts === null ? Prisma.DbNull : body.transcribedSubparts;
  if ("difficulty" in body) {
    // Clamp 1-5; null clears the rating. 0 is the existing 'tried but
    // failed' sentinel — admin override sets a real value.
    const d = body.difficulty;
    data.difficulty = d == null ? null : Math.max(1, Math.min(5, Number(d)));
  }

  console.log("[questions PATCH] id:", id, "fields:", Object.keys(data));
  let question;
  try {
    question = await prisma.examQuestion.update({
      where: { id },
      data,
      include: { examPaper: { include: { questions: { select: { marksAwarded: true } } } } },
    });
    console.log("[questions PATCH] success for id:", id);
  } catch (err: unknown) {
    console.log("[questions PATCH] error for id:", id, "fields:", Object.keys(data), err);
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
