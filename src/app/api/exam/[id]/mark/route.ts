import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markExamPaper, remarkSingleQuestion, markFocusedTest, markQuizPaper } from "@/lib/marking";

// Compute per-booklet/paper scores from metadata.papers + questions
function computeBookletScores(
  metadata: unknown,
  questions: Array<{ questionNum: string; marksAwarded: number | null; marksAvailable: number | null }>
): Array<{ label: string; awarded: number; available: number }> | null {
  const metaPapers = (metadata as { papers?: Array<{ label: string; questionPrefix: string }> })?.papers ?? [];
  if (metaPapers.length <= 1) return null;

  const scores: Array<{ label: string; awarded: number; available: number }> = [];
  for (const mp of metaPapers) {
    let awarded = 0;
    let available = 0;
    for (const q of questions) {
      const matchesPrefix = mp.questionPrefix === ""
        ? !metaPapers.some(other => other.questionPrefix !== "" && q.questionNum.startsWith(other.questionPrefix))
        : q.questionNum.startsWith(mp.questionPrefix);
      if (matchesPrefix) {
        awarded += q.marksAwarded ?? 0;
        available += q.marksAvailable ?? 0;
      }
    }
    scores.push({ label: mp.label, awarded, available });
  }
  return scores;
}

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
      metadata: true,
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
          studentAnswer: true,
          elaboration: true,
          flagged: true,
          syllabusTopic: true,
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
        metadata: true,
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
            syllabusTopic: true,
          },
        },
      },
    });
    if (master) {
      const cloneByNum = new Map(
        paper.questions.map((q) => [q.questionNum, q])
      );
      // Build merged list using master structure + clone marking data
      const merged = master.questions.map((mq) => {
        const cq = cloneByNum.get(mq.questionNum);
        return {
          id: cq?.id ?? mq.questionNum,
          questionNum: mq.questionNum,
          pageIndex: mq.pageIndex,
          orderIndex: mq.orderIndex,
          yStartPct: mq.yStartPct ?? null,
          yEndPct: mq.yEndPct ?? null,
          answer: mq.answer,
          syllabusTopic: mq.syllabusTopic ?? null,
          marksAwarded: cq?.marksAwarded ?? null,
          marksAvailable: mq.marksAvailable,
          markingNotes: cq?.markingNotes ?? null,
          studentAnswer: cq?.studentAnswer ?? null,
          elaboration: cq?.elaboration ?? null,
          flagged: cq?.flagged ?? false,
        };
      });
      const { sourceExamId: _, questions: __, metadata: _meta, ...rest } = paper;
      const bookletScores = computeBookletScores(master.metadata, merged);
      return NextResponse.json({ ...rest, questions: merged, ...(bookletScores ? { bookletScores } : {}) });
    }
  }

  // Strip sourceExamId and metadata from response
  const { sourceExamId: _, metadata: _meta, ...response } = paper;
  const bookletScores = computeBookletScores(paper.metadata, paper.questions);
  return NextResponse.json({ ...response, ...(bookletScores ? { bookletScores } : {}) });
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
    console.log(`[mark API] Re-mark triggered for paper=${id}, questionId=${questionId}`);
    remarkSingleQuestion(questionId).catch((err) =>
      console.error(`[mark API] Re-mark question ${questionId} failed:`, err)
    );
    return NextResponse.json({ status: "remarking" });
  }

  // Full paper mark — set status then fire and forget
  // (allow re-triggering even if previously in_progress, to recover from stuck jobs)
  if (paper.paperType === "quiz") {
    markQuizPaper(id).catch((err) =>
      console.error(`Quiz marking for ${id} failed:`, err)
    );
  } else if (paper.paperType === "focused") {
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
