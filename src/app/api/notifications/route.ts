import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/notifications?userId=X
// Returns unread admin replies for questions flagged by this user
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json([]);

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
