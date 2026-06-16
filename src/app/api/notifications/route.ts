import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveActor } from "@/lib/auth-guard";

// GET /api/notifications[?userId=<target>]
// Returns unread admin replies for questions flagged by the
// caller. Non-admins always see their own; admins may pass
// ?userId= to view another user's pending notifications.
export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const questions = await prisma.examQuestion.findMany({
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
  });

  return NextResponse.json(
    questions.map((q) => ({
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
    }))
  );
}

// POST /api/notifications/mark-read
// Body: { userId, questionIds }
export async function POST(request: NextRequest) {
  const { userId, questionIds } = await request.json();
  if (!userId || !Array.isArray(questionIds) || questionIds.length === 0) {
    return NextResponse.json({ ok: true });
  }

  await prisma.examQuestion.updateMany({
    where: {
      id: { in: questionIds },
      flaggedByUserId: userId,
    },
    data: { adminReplyRead: true },
  });

  return NextResponse.json({ ok: true });
}
