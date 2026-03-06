import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markExamPaper, remarkSingleQuestion, markFocusedTest } from "@/lib/marking";

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
      sourceExamId: true,
      markingStatus: true,
      score: true,
      feedbackSummary: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true,
          questionNum: true,
          pageIndex: true,
          yStartPct: true,
          yEndPct: true,
          answer: true,
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

  // If this is a clone, overlay the latest answer/marks from the master paper
  // so the review always shows the most up-to-date Q&A the parent edited
  if (paper.sourceExamId) {
    const master = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: {
        questions: {
          select: { questionNum: true, answer: true, marksAvailable: true },
        },
      },
    });
    if (master) {
      const masterByNum = new Map(
        master.questions.map((q) => [q.questionNum, q])
      );
      for (const q of paper.questions) {
        const mq = masterByNum.get(q.questionNum);
        if (mq) {
          q.answer = mq.answer;
          if (mq.marksAvailable != null) q.marksAvailable = mq.marksAvailable;
        }
      }
    }
  }

  // Strip sourceExamId from response
  const { sourceExamId: _, ...response } = paper;
  return NextResponse.json(response);
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
    select: { markingStatus: true, completedAt: true, paperType: true },
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
  if (paper.paperType === "focused") {
    markFocusedTest(id).catch((err) =>
      console.error(`Focused test marking for ${id} failed:`, err)
    );
  } else {
    markExamPaper(id).catch((err) =>
      console.error(`Background marking for ${id} failed:`, err)
    );
  }

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
