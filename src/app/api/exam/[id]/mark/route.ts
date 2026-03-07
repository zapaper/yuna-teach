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
          orderIndex: true,
          yStartPct: true,
          yEndPct: true,
          answer: true,
          marksAwarded: true,
          marksAvailable: true,
          markingNotes: true,
          elaboration: true,
          flagged: true,
        },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If this is a clone, use the master's question structure as the source of
  // truth for questionNum, answer, marksAvailable, and pageIndex. Pull marking
  // results (marksAwarded, markingNotes) from the clone by questionNum match.
  // This handles splits (e.g. "35" → "35ab","35c") correctly.
  if (paper.sourceExamId) {
    const master = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: {
        questions: {
          orderBy: { orderIndex: "asc" as const },
          select: {
            questionNum: true,
            answer: true,
            marksAvailable: true,
            pageIndex: true,
            orderIndex: true,
            yStartPct: true,
            yEndPct: true,
          },
        },
      },
    });
    if (master) {
      const cloneByNum = new Map(
        paper.questions.map((q) => [q.questionNum, q])
      );
      // Build merged list using master structure + clone marking data
      const baseNumOf = (qn: string) => qn.replace(/[a-z]+$/i, "");
      const merged = master.questions.map((mq, i) => {
        const cq = cloneByNum.get(mq.questionNum);
        // Fix split questions sharing the same pageIndex:
        // if this segment has a suffix and the previous segment is the same base
        // question on the same page, bump to next page
        let pageIndex = mq.pageIndex;
        if (i > 0 && mq.questionNum !== baseNumOf(mq.questionNum)) {
          const prev = master.questions[i - 1];
          if (baseNumOf(prev.questionNum) === baseNumOf(mq.questionNum) && prev.pageIndex === mq.pageIndex) {
            pageIndex = mq.pageIndex + 1;
          }
        }
        return {
          id: cq?.id ?? mq.questionNum,
          questionNum: mq.questionNum,
          pageIndex,
          orderIndex: mq.orderIndex,
          yStartPct: mq.yStartPct ?? null,
          yEndPct: mq.yEndPct ?? null,
          answer: mq.answer,
          marksAwarded: cq?.marksAwarded ?? null,
          marksAvailable: mq.marksAvailable,
          markingNotes: cq?.markingNotes ?? null,
          elaboration: cq?.elaboration ?? null,
          flagged: cq?.flagged ?? false,
        };
      });
      const { sourceExamId: _, questions: __, ...rest } = paper;
      return NextResponse.json({ ...rest, questions: merged });
    }
  }

  // Fix split questions sharing the same pageIndex (non-clone papers)
  const baseNum = (qn: string) => qn.replace(/[a-z]+$/i, "");
  for (let i = 1; i < paper.questions.length; i++) {
    const q = paper.questions[i];
    if (q.questionNum !== baseNum(q.questionNum)) {
      const prev = paper.questions[i - 1];
      if (baseNum(prev.questionNum) === baseNum(q.questionNum) && prev.pageIndex === q.pageIndex) {
        q.pageIndex = q.pageIndex + 1;
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
