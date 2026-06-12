import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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

  // Was this paper actually printed-and-scanned?
  // Two signals:
  //   - English Test Quiz: printableBounds populated on every question
  //     when the printable PDF was generated.
  //   - Chinese: the OEQ pad generator writes
  //     metadata.normalExtractChinese.oeqPadFirstPageIndex on the
  //     MASTER (clones inherit it) and the pad page indices land on
  //     questions whose pageIndex >= paper.pageCount. We treat that
  //     metadata being present as the "Chinese printed" signal so
  //     the review UI surfaces scanned pages alongside Q33-Q40 etc.
  const printableCount = await prisma.examQuestion.count({
    where: { examPaperId: id, printableBounds: { not: Prisma.AnyNull } },
  });
  const ownMeta = paper.metadata as { normalExtractChinese?: { oeqPadFirstPageIndex?: number }; skipPages?: number[]; answerPages?: number[] } | null;
  let chinesePadFlag = !!ownMeta?.normalExtractChinese?.oeqPadFirstPageIndex;
  // For clones, fall back to the source master's metadata to detect
  // the print/scan workflow signals. Clones inherit metadata indirectly
  // via the print route, but historical clones might not have the
  // skipPages/answerPages stamped on themselves directly.
  let inheritedSkipPages: number[] | undefined;
  let inheritedAnswerPages: number[] | undefined;
  if (paper.sourceExamId) {
    const src = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { metadata: true },
    });
    const srcMeta = src?.metadata as { normalExtractChinese?: { oeqPadFirstPageIndex?: number }; skipPages?: number[]; answerPages?: number[] } | null;
    if (!chinesePadFlag) chinesePadFlag = !!srcMeta?.normalExtractChinese?.oeqPadFirstPageIndex;
    inheritedSkipPages = srcMeta?.skipPages;
    inheritedAnswerPages = srcMeta?.answerPages;
  }
  // English / generic scan-back signal — same defensive fallback the
  // POST /mark routing uses. Catches papers where the print-flow ran
  // but printableBounds didn't land on questions (older extractions,
  // pre-fix English exam prints, etc.) so the review UI still
  // surfaces the scanned page section even without bounds.
  const skipPages = ownMeta?.skipPages ?? inheritedSkipPages;
  const answerPages = ownMeta?.answerPages ?? inheritedAnswerPages;
  const hasScanBackMetadata =
    (Array.isArray(skipPages) && skipPages.length > 0) ||
    (Array.isArray(answerPages) && answerPages.length > 0);
  const isPrintedAndScanned = printableCount > 0 || chinesePadFlag || hasScanBackMetadata;

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
            answerImageData: true,
            marksAvailable: true,
            pageIndex: true,
            orderIndex: true,
            yStartPct: true,
            yEndPct: true,
            xStartPct: true,
            xEndPct: true,
            syllabusTopic: true,
            // Question CONTENT used by the review page renderer.
            // Without these the clone-as-source path (English Test
            // Quiz, Chinese Test Quiz, scan-back exams etc.) returned
            // empty stems / options / images, and the per-question
            // cards on /exam/[id]/review showed up blank ("all the
            // grammar mcq in review is empty"). Pull from master;
            // clones don't duplicate this content.
            transcribedStem: true,
            transcribedOptions: true,
            transcribedOptionImages: true,
            transcribedOptionTable: true,
            transcribedSubparts: true,
            imageData: true,
            diagramImageData: true,
            diagramBounds: true,
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
          xStartPct: mq.xStartPct ?? null,
          xEndPct: mq.xEndPct ?? null,
          answer: mq.answer,
          answerImageData: mq.answerImageData ?? null,
          syllabusTopic: mq.syllabusTopic ?? null,
          marksAwarded: cq?.marksAwarded ?? null,
          marksAvailable: mq.marksAvailable,
          markingNotes: cq?.markingNotes ?? null,
          studentAnswer: cq?.studentAnswer ?? null,
          elaboration: cq?.elaboration ?? null,
          flagged: cq?.flagged ?? false,
          // Question content from master — see select-list comment above.
          transcribedStem: mq.transcribedStem ?? null,
          transcribedOptions: mq.transcribedOptions ?? null,
          transcribedOptionImages: mq.transcribedOptionImages ?? null,
          transcribedOptionTable: mq.transcribedOptionTable ?? null,
          transcribedSubparts: mq.transcribedSubparts ?? null,
          imageData: mq.imageData ?? null,
          diagramImageData: mq.diagramImageData ?? null,
          diagramBounds: mq.diagramBounds ?? null,
        };
      });
      const { sourceExamId: _, questions: __, metadata: cloneMeta, ...rest } = paper;
      const bookletScores = computeBookletScores(master.metadata, merged);
      // Surface isRevision so the review UI can suppress the score
      // ring on compiled-revision papers (would otherwise read 0%).
      const isRevision = !!(cloneMeta as { revisionMode?: string } | null)?.revisionMode;
      return NextResponse.json({ ...rest, questions: merged, isRevision, isPrintedAndScanned, ...(bookletScores ? { bookletScores } : {}) });
    }
  }

  // Strip sourceExamId and metadata from response
  const { sourceExamId: _, metadata: paperMeta, ...response } = paper;
  const bookletScores = computeBookletScores(paper.metadata, paper.questions);
  const isRevision = !!(paperMeta as { revisionMode?: string } | null)?.revisionMode;
  return NextResponse.json({ ...response, isRevision, isPrintedAndScanned, ...(bookletScores ? { bookletScores } : {}) });
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
  // [mark API] entry log dropped — `[quiz-marking] Starting for ...` is
  // already emitted from inside the marker and gives the same signal.

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { markingStatus: true, completedAt: true, paperType: true, subject: true, metadata: true, sourceExamId: true },
  });

  if (!paper) {
    console.warn(`[mark API] Paper ${id} not found`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Paper is considered submittable-for-marking if:
  //   (a) completedAt is set (normal happy path), or
  //   (b) it already has a markingStatus (previously attempted a mark), or
  //   (c) there's at least one studentAnswer on file (student did answer something)
  // If none of those, bounce. Otherwise, backfill completedAt and proceed —
  // this covers cases where the student's PATCH to set completedAt failed but
  // their submission files + answers are on disk.
  if (!paper.completedAt) {
    const hasActivity = paper.markingStatus !== null;
    let hasAnswers = false;
    if (!hasActivity) {
      const answered = await prisma.examQuestion.count({
        where: { examPaperId: id, NOT: { studentAnswer: null } },
      });
      hasAnswers = answered > 0;
    }
    if (!hasActivity && !hasAnswers) {
      console.warn(`[mark API] Paper ${id} has no completedAt and no activity — refusing to mark`);
      return NextResponse.json(
        { error: "Paper has not been submitted yet" },
        { status: 400 }
      );
    }
    console.log(`[mark API] Paper ${id} has no completedAt but has activity — backfilling completedAt=now`);
    await prisma.examPaper.update({
      where: { id },
      data: { completedAt: new Date() },
    });
  }
  // Status echo dropped — duplicate of info available elsewhere in the flow.

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
  //
  // Mark status BEFORE firing so a re-mark from a completed/released
  // paper immediately reflects in the dashboard (parent sees the
  // "Marking…" placeholder + card becomes non-clickable). Without
  // this the card would keep showing the OLD score while the marker
  // re-runs in the background, which the user can then click into
  // and see stale data.
  await prisma.examPaper.update({
    where: { id },
    data: { markingStatus: "in_progress" },
  });

  // Routing key. paperType is the authoritative signal — never the
  // subject, never inherited metadata:
  //   - "quiz"            → markQuizPaper  (typed / in-app)
  //   - "focused"/"mastery" → markFocusedTest (instant-feedback)
  //   - null              → markExamPaper (master paper OR printed-and-scanned clone)
  //
  // Previous order tried to detect "is this a print-and-scan?" first
  // via printableBounds / Chinese OEQ-pad / inherited skipPages-or-
  // answerPages metadata. The metadata signal was a bug: a typed
  // English quiz cloned from a real PSLE master inherits the master's
  // `answerPages` array, which made hasScanBackMetadata=true and
  // routed the typed quiz into markExamPaper. That marker then
  // searched for submission JPEGs that don't exist for typed quizzes
  // ("Submission file not found for page X" 9x → 0 results → marking
  // as failed). paperType="quiz" must always go to markQuizPaper
  // regardless of what answer-page metadata the master had. Same for
  // focused/mastery. Print-and-scan clones carry paperType=null.
  if (paper.paperType === "quiz") {
    markQuizPaper(id).catch((err) =>
      console.error(`Quiz marking for ${id} failed:`, err)
    );
  } else if (paper.paperType === "focused" || paper.paperType === "mastery") {
    // Mastery quizzes share the focused-test shape (cloned questions
    // with no scanned pages, instant-feedback marking). Route them
    // through the same marker so MCQ scores and OEQ AI marking both
    // run. Without this branch, mastery papers fell through to
    // markExamPaper (the master-paper / scanned-submission marker)
    // and silently skipped marking — leading to "-%" scores and
    // empty marking notes.
    markFocusedTest(id).catch((err) =>
      console.error(`${paper.paperType} test marking for ${id} failed:`, err)
    );
  } else {
    // paperType === null — master paper OR printed-and-scanned clone.
    // Either way, markExamPaper handles it (it's no-op-on-master and
    // does the real scan-back marking on clones with submission JPEGs).
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
