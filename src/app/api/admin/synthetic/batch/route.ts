import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

// Returns up to 10 clean MCQ questions pending synthetic generation. Supports
// filtering by subject, paper level and paper examType (WA1 / WA2 / EOY /
// Prelim / …) so the admin UI can focus generation on specific pools like
// "P6 Math WA2→EOY" without pulling primary-3 warm-ups.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const qs = request.nextUrl.searchParams;
  const subjectParam = (qs.get("subject") ?? "math").toLowerCase();
  const subjectMatch = subjectParam === "science" ? "science" : subjectParam === "english" ? "english" : "math";
  // Optional filters. If omitted, no restriction is applied.
  const levelParam = qs.get("level"); // "P6", "P5", etc.
  const examTypesParam = qs.get("examTypes"); // comma-separated, e.g. "WA2,EOY"

  // Exclude the synthetic-bank papers themselves — we don't want to generate
  // variants of variants. They're marked with examType: "Synthetic" on create,
  // and their titles all start with "[Synthetic Bank]".
  const notSyntheticBank = {
    NOT: [
      { examType: "Synthetic" },
      { title: { startsWith: "[Synthetic Bank]" } },
    ],
  };

  // Source pool: Grammar/Vocabulary MCQ for English, plain MCQ for math/science.
  // All four-option questions with a numeric answer (1-4).
  const levelVariants = levelParam
    ? [levelParam, `Primary ${levelParam.replace(/^P/i, "")}`, levelParam.replace(/^P/i, "")]
    : null;
  const examTypes = examTypesParam
    ? examTypesParam.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  const mcqWhere: Prisma.ExamQuestionWhereInput = {
    syntheticGenerated: false,
    transcribedStem: { not: null },
    transcribedOptions: { not: Prisma.JsonNull },
    answer: { not: null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subjectMatch, mode: "insensitive" },
      ...(levelVariants ? { level: { in: levelVariants } } : {}),
      ...(examTypes ? { examType: { in: examTypes } } : {}),
      ...notSyntheticBank,
    },
  };
  const questions = await prisma.examQuestion.findMany({
    where: mcqWhere,
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      answer: true,
      diagramImageData: true,
      syllabusTopic: true,
      syntheticGenerated: true,
      syntheticQuestions: {
        select: { variant: true, stem: true, options: true, correctAnswer: true, diagramImageData: true },
      },
      examPaper: { select: { id: true, title: true, year: true, school: true, level: true, examType: true } },
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
      optionImages: q.transcribedOptionImages,
      correctAnswer: parseMcqAnswer(q.answer),
      diagramImageData: q.diagramImageData,
      syllabusTopic: q.syllabusTopic,
      syntheticGenerated: q.syntheticGenerated,
      syntheticQuestions: q.syntheticQuestions,
      paperTitle: q.examPaper.title,
      paperYear: q.examPaper.year,
      paperSchool: q.examPaper.school,
      paperLevel: q.examPaper.level,
      paperExamType: q.examPaper.examType,
    })),
  });
}
