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
      transcribedStem: true,
      syllabusTopic: true,
      sourceQuestionId: true,
      examPaper: {
        select: {
          id: true,
          title: true,
          subject: true,
          level: true,
          school: true,
          year: true,
          examType: true,
          paperType: true,
          sourceExamId: true,
          assignedTo: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Batch-fetch source question info for quiz/focused questions
  const sourceIds = flagged.map(q => q.sourceQuestionId).filter(Boolean) as string[];
  const sourceMap: Record<string, { paperId: string; questionNum: string; school: string | null; year: string | null; examType: string | null }> = {};
  if (sourceIds.length > 0) {
    const sourceQuestions = await prisma.examQuestion.findMany({
      where: { id: { in: sourceIds } },
      select: {
        id: true,
        questionNum: true,
        examPaper: { select: { id: true, school: true, year: true, examType: true } },
      },
    });
    for (const sq of sourceQuestions) {
      sourceMap[sq.id] = {
        paperId: sq.examPaper.id,
        questionNum: sq.questionNum,
        school: sq.examPaper.school,
        year: sq.examPaper.year,
        examType: sq.examPaper.examType,
      };
    }
  }

  const items = flagged.map((q) => {
    const src = q.sourceQuestionId ? sourceMap[q.sourceQuestionId] : null;
    return {
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
      paperType: q.examPaper.paperType,
      paperTitle: q.examPaper.title,
      subject: q.examPaper.subject,
      level: q.examPaper.level,
      // For quiz/focused: use source paper's school/year/examType; fall back to paper's own fields
      school: src?.school ?? q.examPaper.school,
      year: src?.year ?? q.examPaper.year,
      examType: src?.examType ?? q.examPaper.examType,
      transcribedStem: q.transcribedStem,
      syllabusTopic: q.syllabusTopic,
      studentName: q.examPaper.assignedTo?.name ?? null,
      parentName: q.examPaper.user?.name ?? null,
      // Source question link (for editing)
      sourcePaperId: src?.paperId ?? null,
      sourceQuestionNum: src?.questionNum ?? null,
    };
  });

  return NextResponse.json(items);
}
