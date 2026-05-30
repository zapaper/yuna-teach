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
      flagText: true,
      flagVoiceNote: true,
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

  // Batch-fetch source question info for quiz/focused questions.
  // Walk the sourceQuestionId chain up to 4 hops — a Chinese flagged
  // question can land on a question whose source is ANOTHER test
  // quiz (older daily-quiz Chinese branch sourced from any paper
  // with sourceExamId=null, including paperType="quiz"). Stop at the
  // first paperType=null hop (the real master) or when we've gone
  // 4 deep.
  const sourceIds = flagged.map(q => q.sourceQuestionId).filter(Boolean) as string[];
  const sourceMap: Record<string, { paperId: string; questionNum: string; school: string | null; year: string | null; examType: string | null }> = {};
  if (sourceIds.length > 0) {
    type Hop = { id: string; questionNum: string; school: string | null; year: string | null; examType: string | null; sourceQuestionId: string | null; paperType: string | null; paperId: string };
    // resolved[startId] = ultimate Hop reached after walking.
    const resolved = new Map<string, Hop>();
    // pendingByStart[startId] = the id we still need to look up.
    let pendingByStart = new Map<string, string>(sourceIds.map(id => [id, id]));
    for (let depth = 0; depth < 4 && pendingByStart.size > 0; depth++) {
      const toFetch = [...new Set(pendingByStart.values())];
      const rows = await prisma.examQuestion.findMany({
        where: { id: { in: toFetch } },
        select: {
          id: true,
          questionNum: true,
          sourceQuestionId: true,
          examPaper: { select: { id: true, school: true, year: true, examType: true, paperType: true } },
        },
      });
      const fetchedById = new Map(rows.map(r => [r.id, {
        id: r.id,
        questionNum: r.questionNum,
        school: r.examPaper.school,
        year: r.examPaper.year,
        examType: r.examPaper.examType,
        sourceQuestionId: r.sourceQuestionId,
        paperType: r.examPaper.paperType,
        paperId: r.examPaper.id,
      } as Hop]));
      const nextPending = new Map<string, string>();
      for (const [startId, currentId] of pendingByStart) {
        const hop = fetchedById.get(currentId);
        if (!hop) {
          // Row vanished — give up on this chain.
          continue;
        }
        // Reached the real master (no further sourceQuestionId, or
        // paperType is null which marks an uploaded source paper).
        if (!hop.sourceQuestionId || hop.paperType === null) {
          resolved.set(startId, hop);
          continue;
        }
        // Else keep walking.
        nextPending.set(startId, hop.sourceQuestionId);
      }
      pendingByStart = nextPending;
    }
    for (const [startId, hop] of resolved) {
      sourceMap[startId] = {
        paperId: hop.paperId,
        questionNum: hop.questionNum,
        school: hop.school,
        year: hop.year,
        examType: hop.examType,
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
      // Flag notes left by whoever raised the flag.
      flagText: q.flagText,
      flagVoiceNote: q.flagVoiceNote,
    };
  });

  return NextResponse.json(items);
}
