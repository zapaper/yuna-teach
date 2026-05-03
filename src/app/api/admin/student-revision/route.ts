import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { fetchMistakeQuestions, orderMistakesForRevision, type SubjectKey } from "@/lib/revision";

// POST /api/admin/student-revision
//
// Body: { studentId, subject: 'math'|'science'|'english', count: number, mode: 'review'|'practice' }
//
// Compiles a new ExamPaper out of the student's recent mistakes for
// the given subject:
//   review   → marked paper. completedAt set, marksAwarded /
//              studentAnswer / markingNotes preserved, redirects
//              parent to /exam/<id>/review
//   practice → blank paper. No marks, no studentAnswer. Redirects
//              parent to /exam/<id> so the student can do it.
// Both use paperType="quiz" so the dashboard cards / quiz player
// flows already work.

const SUBJECT_LABEL: Record<SubjectKey, string> = {
  math: "Math",
  science: "Science",
  english: "English",
};
const SUBJECT_FULL: Record<SubjectKey, string> = {
  math: "Mathematics",
  science: "Science",
  english: "English Language",
};

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const adminId = await getSessionUserId();
  if (!adminId) return NextResponse.json({ error: "no session" }, { status: 401 });

  let body: { studentId?: string; subject?: SubjectKey; count?: number; mode?: "review" | "practice" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const { studentId, subject, count, mode } = body;
  if (!studentId || !subject || !count || !mode) {
    return NextResponse.json({ error: "studentId, subject, count, mode required" }, { status: 400 });
  }
  if (subject !== "math" && subject !== "science" && subject !== "english") {
    return NextResponse.json({ error: "invalid subject" }, { status: 400 });
  }
  if (mode !== "review" && mode !== "practice") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return NextResponse.json({ error: "count out of range" }, { status: 400 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, level: true, role: true },
  });
  if (!student || student.role !== "STUDENT") {
    return NextResponse.json({ error: "student not found" }, { status: 404 });
  }

  // Pull a generous candidate set so the ordering pass has room to
  // place comp-OEQ at the end / MCQs first without truncating
  // arbitrarily. We then trim to `count`.
  const mistakes = await fetchMistakeQuestions(studentId, subject, Math.max(count * 3, 60));
  if (mistakes.length === 0) {
    return NextResponse.json({ error: "no mistakes found for this subject" }, { status: 404 });
  }
  const ordered = orderMistakesForRevision(subject, mistakes).slice(0, count);

  // Each MistakeQuestion already carries the clone's full content
  // (transcribedStem etc.) — that's what the student actually saw,
  // and pulling from the clone preserves any clean-extract that was
  // run after the master was first uploaded. Source content might
  // even be different from what the student saw, so we always
  // prefer clone content.
  type QuestionCreate = Prisma.ExamQuestionCreateWithoutExamPaperInput;
  const questionCreates: QuestionCreate[] = [];
  let i = 0;
  for (const m of ordered) {
    const isReview = mode === "review";
    questionCreates.push({
      questionNum: String(i + 1),
      imageData: m.imageData ?? "",
      answer: m.answer,
      answerImageData: m.answerImageData,
      pageIndex: 0,
      orderIndex: i,
      marksAvailable: m.marksAvailable,
      syllabusTopic: m.syllabusTopic,
      transcribedStem: m.transcribedStem,
      transcribedOptions: (m.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      transcribedOptionImages: (m.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      transcribedSubparts: (m.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      diagramImageData: m.diagramImageData,
      diagramBounds: (m.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      // sourceQuestionId points at the master so future re-marking /
      // cross-paper analytics still trace back correctly.
      sourceQuestionId: m.sourceQuestionId,
      // Review mode: re-attach the student's prior marking artefacts
      // so the review page renders exactly what the parent saw at
      // grading time.
      ...(isReview ? {
        marksAwarded: m.marksAwarded,
        studentAnswer: m.studentAnswer,
        markingNotes: m.markingNotes,
      } : {}),
    });
    i++;
  }
  if (questionCreates.length === 0) {
    return NextResponse.json({ error: "no source questions resolved" }, { status: 404 });
  }

  const totalMarks = questionCreates.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
  const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const levelLabel = student.level ? `P${student.level} ` : "";
  const title = `${levelLabel}${SUBJECT_LABEL[subject]} Revision ${dateLabel}`;

  const paper = await prisma.examPaper.create({
    data: {
      title,
      subject: SUBJECT_FULL[subject],
      level: student.level ? `Primary ${student.level}` : null,
      userId: adminId,
      assignedToId: studentId,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      // Review mode: paper is already 'completed' with all marking
      // baked in. Practice: blank paper waiting for the student.
      ...(mode === "review"
        ? { completedAt: new Date(), markingStatus: "complete" }
        : {}),
      metadata: {
        revisionMode: mode,
        revisionSubject: subject,
        compiledAt: new Date().toISOString(),
        compiledBy: adminId,
      },
      questions: { create: questionCreates },
    },
    select: { id: true },
  });

  // Deliberately leave paper.score null even for review mode. The
  // revision paper is a compilation of mistakes — showing "0%" or a
  // very low score on the dashboard makes it look like the student
  // scored badly on a fresh quiz, when it's actually a curated set
  // of past errors. scorePct() returns null when score is null and
  // the card just hides the percentage chip.

  const redirectUrl = mode === "review"
    ? `/exam/${paper.id}/review`
    : `/exam/${paper.id}`;

  return NextResponse.json({
    paperId: paper.id,
    title,
    questionCount: questionCreates.length,
    redirectUrl,
  });
}
