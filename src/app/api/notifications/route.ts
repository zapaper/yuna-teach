import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveActor } from "@/lib/auth-guard";

// GET /api/notifications[?userId=<target>]
// Returns unread admin replies the caller has received — from two
// sources:
//   - flagged exam questions: existing flow (replies on ExamQuestion)
//   - feedback submissions:   replies on Feedback (added 2026-06)
// Both shapes carry a `kind` discriminator so the dashboard renders
// each accordingly. Non-admins always see their own; admins may pass
// ?userId= to view another user's pending notifications.
export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const [questions, feedback] = await Promise.all([
    prisma.examQuestion.findMany({
      where: {
        flaggedByUserId: userId,
        adminReply: { not: null },
        adminReplyRead: false,
      },
      select: {
        id: true,
        questionNum: true,
        adminReply: true,
        adminRepliedAt: true,
        transcribedStem: true,
        flagText: true,
        crystalAwarded: true,
        examPaper: {
          select: { id: true, title: true, paperType: true, sourceExamId: true },
        },
      },
      orderBy: { adminRepliedAt: "desc" },
    }),
    prisma.feedback.findMany({
      where: {
        userId,
        adminReply: { not: null },
        adminReplyRead: false,
      },
      select: {
        id: true,
        message: true,
        adminReply: true,
        adminRepliedAt: true,
        createdAt: true,
      },
      orderBy: { adminRepliedAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    questions: questions.map((q) => ({
      kind: "question" as const,
      questionId: q.id,
      questionNum: q.questionNum,
      adminReply: q.adminReply,
      adminRepliedAt: q.adminRepliedAt,
      transcribedStem: q.transcribedStem,
      flagText: q.flagText,
      crystalAwarded: q.crystalAwarded,
      paperId: q.examPaper.sourceExamId ?? q.examPaper.id,
      cloneId: q.examPaper.sourceExamId ? q.examPaper.id : null,
      paperTitle: q.examPaper.title,
      paperType: q.examPaper.paperType,
    })),
    feedback: feedback.map((f) => ({
      kind: "feedback" as const,
      feedbackId: f.id,
      originalMessage: f.message,
      submittedAt: f.createdAt,
      adminReply: f.adminReply,
      adminRepliedAt: f.adminRepliedAt,
    })),
  });
}

// POST /api/notifications/mark-read
// Body: { userId, questionIds?, feedbackIds? }
// Marks any combination of question replies and feedback replies as
// read for the caller. Either id list may be empty.
export async function POST(request: NextRequest) {
  const { userId, questionIds, feedbackIds } = await request.json();
  if (!userId) return NextResponse.json({ ok: true });

  const qIds: string[] = Array.isArray(questionIds) ? questionIds : [];
  const fIds: string[] = Array.isArray(feedbackIds) ? feedbackIds : [];
  if (qIds.length === 0 && fIds.length === 0) return NextResponse.json({ ok: true });

  await Promise.all([
    qIds.length > 0
      ? prisma.examQuestion.updateMany({
          where: { id: { in: qIds }, flaggedByUserId: userId },
          data: { adminReplyRead: true },
        })
      : Promise.resolve(),
    fIds.length > 0
      ? prisma.feedback.updateMany({
          where: { id: { in: fIds }, userId },
          data: { adminReplyRead: true },
        })
      : Promise.resolve(),
  ]);

  return NextResponse.json({ ok: true });
}
