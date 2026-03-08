import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/flagged — returns all flagged questions with paper + student context
export async function GET(_request: NextRequest) {
  const flagged = await prisma.examQuestion.findMany({
    where: { flagged: true },
    orderBy: { flaggedAt: "desc" },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      marksAwarded: true,
      marksAvailable: true,
      markingNotes: true,
      studentAnswer: true,
      flaggedAt: true,
      examPaper: {
        select: {
          id: true,
          title: true,
          subject: true,
          level: true,
          sourceExamId: true,
          assignedTo: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
      },
    },
  });

  const items = flagged.map((q) => ({
    questionId: q.id,
    questionNum: q.questionNum,
    answer: q.answer,
    marksAwarded: q.marksAwarded,
    marksAvailable: q.marksAvailable,
    markingNotes: q.markingNotes,
    studentAnswer: q.studentAnswer,
    flaggedAt: q.flaggedAt,
    paperId: q.examPaper.sourceExamId ?? q.examPaper.id,
    cloneId: q.examPaper.sourceExamId ? q.examPaper.id : null,
    paperTitle: q.examPaper.title,
    subject: q.examPaper.subject,
    level: q.examPaper.level,
    studentName: q.examPaper.assignedTo?.name ?? null,
    parentName: q.examPaper.user?.name ?? null,
  }));

  return NextResponse.json(items);
}
