import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

// Returns up to 10 clean questions pending synthetic generation. Supports
// filtering by subject, question type (mcq/oeq), paper level and examType
// (WA1 / WA2 / EOY / Prelim / …) so the admin UI can focus generation on
// specific pools like "P6 Science OEQ WA2" without pulling P3 warm-ups.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const qs = request.nextUrl.searchParams;
  const subjectParam = (qs.get("subject") ?? "math").toLowerCase();
  const subjectMatch = subjectParam === "science" ? "science" : subjectParam === "english" ? "english" : "math";
  const questionType = (qs.get("type") ?? "mcq").toLowerCase() === "oeq" ? "oeq" : "mcq";
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

  const levelVariants = levelParam
    ? [levelParam, `Primary ${levelParam.replace(/^P/i, "")}`, levelParam.replace(/^P/i, "")]
    : null;
  const examTypes = examTypesParam
    ? examTypesParam.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  const paperFilter = {
    sourceExamId: null,
    paperType: null,
    subject: { contains: subjectMatch, mode: "insensitive" as const },
    ...(levelVariants ? { level: { in: levelVariants } } : {}),
    ...(examTypes ? { examType: { in: examTypes } } : {}),
    ...notSyntheticBank,
  };

  // OEQ branch: multi-subpart open-ended questions. Source pool is questions
  // with a transcribed stem AND at least one transcribed subpart and no text
  // options (those are MCQs). No 1-4 answer parsing needed.
  if (questionType === "oeq") {
    const oeqWhere: Prisma.ExamQuestionWhereInput = {
      syntheticGenerated: false,
      transcribedStem: { not: null },
      transcribedSubparts: { not: Prisma.JsonNull },
      examPaper: paperFilter,
    };
    const questions = await prisma.examQuestion.findMany({
      where: oeqWhere,
      select: {
        id: true,
        questionNum: true,
        transcribedStem: true,
        transcribedSubparts: true,
        transcribedOptions: true,
        answer: true,
        marksAvailable: true,
        diagramImageData: true,
        syllabusTopic: true,
        syntheticGenerated: true,
        syntheticQuestions: {
          where: { questionType: "oeq" },
          select: { variant: true, stem: true, subparts: true, answerText: true, marksAvailable: true, diagramImageData: true },
        },
        examPaper: { select: { id: true, title: true, year: true, school: true, level: true, examType: true } },
      },
      orderBy: [{ syntheticSkipped: "asc" }, { id: "asc" }],
      take: 30,
    });

    // Separate real subparts from the internal sentinel rows:
    //   _subref-<label>   → reference image for that subpart (the student's
    //                       drawable canvas uses this as the background).
    //   _drawable         → the whole question has a drawable canvas that
    //                       accepts freehand drawing (no per-subpart ref).
    // Attach the matching ref image back onto each real subpart so the admin
    // preview and the promoted bank question can show them.
    type CleanSubpart = { label: string; text: string; refImageBase64?: string | null };
    function splitSubparts(raw: unknown): { subparts: CleanSubpart[]; hasDrawable: boolean } {
      if (!Array.isArray(raw)) return { subparts: [], hasDrawable: false };
      const rows = raw
        .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
        .map((r) => ({
          label: String(r.label ?? ""),
          text: String(r.text ?? ""),
          diagramBase64: typeof r.diagramBase64 === "string" ? (r.diagramBase64 as string) : null,
          refImageBase64: typeof r.refImageBase64 === "string" ? (r.refImageBase64 as string) : null,
        }));
      const refs = new Map<string, string>();
      let hasDrawable = false;
      for (const r of rows) {
        if (!r.label.startsWith("_")) continue;
        if (r.label === "_drawable") { hasDrawable = true; continue; }
        if (r.label.startsWith("_subref-")) {
          const target = r.label.slice("_subref-".length).toLowerCase();
          // Sentinel stores the actual image in diagramBase64 (see
          // transcribe-edit/page.tsx), fall back to refImageBase64 if present.
          const img = r.diagramBase64 ?? r.refImageBase64 ?? null;
          if (target && img) refs.set(target, img);
        }
      }
      const subparts: CleanSubpart[] = rows
        .filter((r) => r.label && !r.label.startsWith("_") && r.text)
        .map((r) => ({
          label: r.label,
          text: r.text,
          refImageBase64: r.refImageBase64 ?? refs.get(r.label.toLowerCase()) ?? null,
        }));
      return { subparts, hasDrawable };
    }
    // Drop OEQs that were split across multiple records in the same paper
    // (e.g. "38a" in one row + "38bc" in another). Only complete standalone
    // questions — questionNum unique by base within its paper — make the cut.
    const baseNum = (qn: string | null | undefined) =>
      String(qn ?? "").replace(/[a-z)(.,\s]+$/i, "").trim();
    const splitKeys = new Set<string>();
    const basesSeen = new Map<string, Set<string>>(); // paperId → set of base numbers seen twice
    const firstSeen = new Map<string, string>(); // paperId+base → first questionNum
    for (const q of questions) {
      const base = baseNum(q.questionNum);
      if (!base) continue;
      const key = `${q.examPaper.id}::${base}`;
      if (firstSeen.has(key) && firstSeen.get(key) !== q.questionNum) {
        splitKeys.add(key);
        const set = basesSeen.get(q.examPaper.id) ?? new Set();
        set.add(base);
        basesSeen.set(q.examPaper.id, set);
      } else {
        firstSeen.set(key, q.questionNum);
      }
    }
    const isSplit = (q: (typeof questions)[number]) => splitKeys.has(`${q.examPaper.id}::${baseNum(q.questionNum)}`);

    const filtered = questions
      .filter((q) => {
        if (isSplit(q)) return false;
        if (splitSubparts(q.transcribedSubparts).subparts.length === 0) return false;
        const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as unknown[]) : [];
        if (opts.some((o) => typeof o === "string" && o.trim().length > 0)) return false;
        return !!(q.answer && q.answer.trim());
      })
      .slice(0, 10);

    return NextResponse.json({
      type: "oeq",
      questions: filtered.map((q) => {
        const { subparts: cleanSubs, hasDrawable } = splitSubparts(q.transcribedSubparts);
        return {
        id: q.id,
        questionNum: q.questionNum,
        stem: q.transcribedStem,
        subparts: cleanSubs,
        hasDrawable,
        answerText: q.answer,
        marksAvailable: q.marksAvailable ?? 0,
        diagramImageData: q.diagramImageData,
        syllabusTopic: q.syllabusTopic,
        syntheticGenerated: q.syntheticGenerated,
        syntheticQuestions: q.syntheticQuestions,
        paperTitle: q.examPaper.title,
        paperYear: q.examPaper.year,
        paperSchool: q.examPaper.school,
        paperLevel: q.examPaper.level,
        paperExamType: q.examPaper.examType,
      };
      }),
    });
  }

  // MCQ branch (original behaviour). Source pool: Grammar/Vocabulary MCQ for
  // English, plain MCQ for math/science. All four-option questions with a
  // numeric answer (1-4). Vocabulary Cloze MCQ is intentionally excluded —
  // its question shape is "passage with a blank, pick the word", and the
  // synthetic generator targets standalone Grammar/Vocab MCQ only.
  const mcqWhere: Prisma.ExamQuestionWhereInput = {
    syntheticGenerated: false,
    transcribedStem: { not: null },
    transcribedOptions: { not: Prisma.JsonNull },
    answer: { not: null },
    NOT: { syllabusTopic: { contains: "cloze", mode: "insensitive" } },
    examPaper: paperFilter,
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
        where: { questionType: "mcq" },
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
    type: "mcq",
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
