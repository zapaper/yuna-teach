import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

// Returns up to 10 clean math MCQ questions that have not yet had synthetic questions generated.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const subjectParam = (request.nextUrl.searchParams.get("subject") ?? "math").toLowerCase();
  const subjectMatch = subjectParam === "science" ? "science" : subjectParam === "english" ? "english" : "math";

  const questions = await prisma.examQuestion.findMany({
    where: {
      syntheticGenerated: false,
      transcribedStem: { not: null },
      transcribedOptions: { not: Prisma.JsonNull },
      answer: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: subjectMatch, mode: "insensitive" },
      },
    },
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

  const filtered = questions.filter(q => parseMcqAnswer(q.answer) !== null).slice(0, 10);

  return NextResponse.json({
    questions: filtered.map(q => ({
      id: q.id,
      questionNum: q.questionNum,
      stem: q.transcribedStem,
      options: q.transcribedOptions,
      correctAnswer: parseMcqAnswer(q.answer),
      diagramImageData: q.diagramImageData,
      syntheticGenerated: q.syntheticGenerated,
      syntheticQuestions: q.syntheticQuestions,
      paperTitle: q.examPaper.title,
      paperYear: q.examPaper.year,
      paperSchool: q.examPaper.school,
    })),
  });
}
