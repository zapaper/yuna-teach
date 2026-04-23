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
      flaggedByUserId: true,
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
          metadata: true,
          sourceExamId: true,
          createdAt: true,
          completedAt: true,
          assignedTo: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Batch-fetch flagger user info
  const flaggerIds = [...new Set(flagged.map(q => q.flaggedByUserId).filter(Boolean) as string[])];
  const flaggers = flaggerIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: flaggerIds } }, select: { id: true, name: true, role: true } })
    : [];
  const flaggerMap = new Map(flaggers.map(u => [u.id, u]));

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

    // Fallback: parse sourceLabels from quiz paper metadata (for questions created before sourceQuestionId was added)
    const meta = q.examPaper.metadata as { sourceLabels?: Record<string, string | null> } | null;
    const sourceLabel = meta?.sourceLabels?.[q.questionNum] ?? null;
    // sourceLabel format: "2023 WA1 Nanyang Primary School" — split into year/examType/school
    let labelYear: string | null = null;
    let labelExamType: string | null = null;
    let labelSchool: string | null = null;
    if (sourceLabel && !src) {
      const parts = sourceLabel.split(" ");
      // First token that looks like a year (4 digits)
      const yearIdx = parts.findIndex(p => /^\d{4}$/.test(p));
      if (yearIdx >= 0) labelYear = parts[yearIdx];
      // Known exam types
      const knownTypes = ["WA1", "WA2", "WA3", "SA1", "SA2", "EOY", "Prelim", "End of Year"];
      const typeToken = parts.find(p => knownTypes.some(t => t.toLowerCase() === p.toLowerCase()));
      if (typeToken) labelExamType = typeToken;
      // Remaining tokens = school name
      const schoolParts = parts.filter(p => p !== labelYear && p !== labelExamType);
      if (schoolParts.length > 0) labelSchool = schoolParts.join(" ");
    }

    return {
      questionId: q.id,
      questionNum: q.questionNum,
      answer: q.answer,
      marksAwarded: q.marksAwarded,
      marksAvailable: q.marksAvailable,
      markingNotes: q.markingNotes,
      studentAnswer: q.studentAnswer,
      flaggedAt: q.flaggedAt,
      paperCreatedAt: q.examPaper.createdAt,
      paperCompletedAt: q.examPaper.completedAt,
      paperId: q.examPaper.sourceExamId ?? q.examPaper.id,
      cloneId: q.examPaper.sourceExamId ? q.examPaper.id : null,
      paperType: q.examPaper.paperType,
      paperTitle: q.examPaper.title,
      subject: q.examPaper.subject,
      level: q.examPaper.level,
      // Priority: sourceQuestionId lookup → sourceLabels metadata → paper's own fields
      school: src?.school ?? labelSchool ?? q.examPaper.school,
      year: src?.year ?? labelYear ?? q.examPaper.year,
      examType: src?.examType ?? labelExamType ?? q.examPaper.examType,
      sourceLabel,  // raw label string for display fallback
      transcribedStem: q.transcribedStem,
      syllabusTopic: q.syllabusTopic,
      studentName: q.examPaper.assignedTo?.name ?? null,
      parentName: q.examPaper.user?.name ?? null,
      flaggedBy: q.flaggedByUserId ? (flaggerMap.get(q.flaggedByUserId) ?? null) : null,
      // Source question link (for editing) — only available when sourceQuestionId is set
      sourcePaperId: src?.paperId ?? null,
      sourceQuestionId: q.sourceQuestionId ?? null,
      sourceQuestionNum: src?.questionNum ?? null,
    };
  });

  return NextResponse.json(items);
}
