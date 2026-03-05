import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markFocusedTest } from "@/lib/marking";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Save a single answer
  if (body.questionId && "studentAnswer" in body) {
    await prisma.examQuestion.update({
      where: { id: body.questionId },
      data: { studentAnswer: body.studentAnswer ?? null },
    });
    return NextResponse.json({ success: true });
  }

  // Submit the focused test
  if (body.action === "submit") {
    const paper = await prisma.examPaper.findUnique({
      where: { id },
      select: { paperType: true, completedAt: true },
    });
    if (!paper) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.examPaper.update({
      where: { id },
      data: {
        completedAt: new Date(),
        markingStatus: "in_progress",
      },
    });

    // Fire-and-forget marking
    markFocusedTest(id).catch((err) =>
      console.error(`[focused-test] Marking failed for ${id}:`, err)
    );

    return NextResponse.json({ success: true, status: "marking" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
