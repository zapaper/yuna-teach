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

  const question = await prisma.examQuestion.update({ where: { id }, data });

  return NextResponse.json({ success: true, id: question.id });
}
