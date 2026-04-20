import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

// Returns up to 10 clean math MCQ questions that have not yet had synthetic questions generated.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const subjectParam = (request.nextUrl.searchParams.get("subject") ?? "math").toLowerCase();
  const subjectMatch = subjectParam === "science" ? "science" : subjectParam === "english" ? "english" : "math";

  // English synthetic generation: focus on P6 Synthesis & Transformation —
  // the transforms are written, not MCQ, so we don't require transcribedOptions
  // and we narrow to P6 syllabus-topic synthesis.
  const isEnglish = subjectMatch === "english";
  const englishWhere = {
    syntheticGenerated: false,
    transcribedStem: { not: null },
    answer: { not: null },
    syllabusTopic: { contains: "synthesis", mode: "insensitive" as const },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "english", mode: "insensitive" as const },
      level: { in: ["P6", "Primary 6", "6"] },
    },
  };
  const mcqWhere = {
    syntheticGenerated: false,
    transcribedStem: { not: null },
    transcribedOptions: { not: Prisma.JsonNull },
    answer: { not: null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subjectMatch, mode: "insensitive" as const },
    },
  };
  const questions = await prisma.examQuestion.findMany({
    where: isEnglish ? englishWhere : mcqWhere,
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      diagramImageData: true,
      syntheticGenerated: true,
      syntheticQuestions: {
        select: { variant: true, stem: true, options: true, correctAnswer: true, diagramImageData: true },
      },
      examPaper: { select: { id: true, title: true, year: true, school: true } },
    },
    orderBy: [{ syntheticSkipped: "asc" }, { id: "asc" }],
    take: 20, // fetch a few extra in case some have invalid answer format
  });

  function parseMcqAnswer(a: string | null): number | null {
    if (!a) return null;
    const m = a.trim().replace(/[().]/g, "").trim();
    const n = parseInt(m, 10);
    return n >= 1 && n <= 4 ? n : null;
  }

  // MCQ path requires a numeric answer; synthesis path just needs an answer present.
  const filtered = isEnglish
    ? questions.slice(0, 10)
    : questions.filter(q => parseMcqAnswer(q.answer) !== null).slice(0, 10);

  return NextResponse.json({
    questions: filtered.map(q => ({
      id: q.id,
      questionNum: q.questionNum,
      stem: q.transcribedStem,
      options: q.transcribedOptions,
      correctAnswer: isEnglish ? q.answer : parseMcqAnswer(q.answer),
      diagramImageData: q.diagramImageData,
      syntheticGenerated: q.syntheticGenerated,
      syntheticQuestions: q.syntheticQuestions,
      paperTitle: q.examPaper.title,
      paperYear: q.examPaper.year,
      paperSchool: q.examPaper.school,
    })),
  });
}
