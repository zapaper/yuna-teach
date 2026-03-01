import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markExamPaper, remarkSingleQuestion } from "@/lib/marking";

// GET /api/exam/[id]/mark
// Returns marking status + per-question results (with imageData for thumbnails)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      markingStatus: true,
      score: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true,
          questionNum: true,
          pageIndex: true,
          yStartPct: true,
          yEndPct: true,
          imageData: true,
          marksAwarded: true,
          marksAvailable: true,
          markingNotes: true,
        },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(paper);
}

// POST /api/exam/[id]/mark
//   No body  → mark the full paper (fire-and-forget, returns immediately)
//   ?questionId=xxx → re-mark a single question (also fire-and-forget)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const questionId = request.nextUrl.searchParams.get("questionId");

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { markingStatus: true, completedAt: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!paper.completedAt) {
    return NextResponse.json(
      { error: "Paper has not been submitted yet" },
      { status: 400 }
    );
  }

  if (questionId) {
    // Re-mark single question — fire and forget
    remarkSingleQuestion(questionId).catch((err) =>
      console.error(`Re-mark question ${questionId} failed:`, err)
    );
    return NextResponse.json({ status: "remarking" });
  }

  // Full paper mark — set status then fire and forget
  // (allow re-triggering even if previously in_progress, to recover from stuck jobs)
  markExamPaper(id).catch((err) =>
    console.error(`Background marking for ${id} failed:`, err)
  );

  return NextResponse.json({ status: "in_progress" });
}

// DELETE /api/exam/[id]/mark — reset marking status so parent can re-trigger
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.examPaper.update({
    where: { id },
    data: { markingStatus: null },
  });
  return NextResponse.json({ success: true });
}
