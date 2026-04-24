import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { isSessionAdmin } from "@/lib/session";
import { classifyDifficultyBatch, type DifficultyInput } from "@/lib/gemini";

// POST — classify the next batch of un-rated master-paper questions.
// Scope: clean-extracted master questions only (transcribedStem NOT NULL,
// sourceExamId NULL, paperType NULL, not a Synthetic Bank paper). Synthetic
// variants inherit their difficulty from the source — handled by GET below.
//
// Batch of 5 per call so a single Gemini round-trip stays under our timeout
// budget and the admin UI can poll incrementally without blocking.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const limit = Math.max(1, Math.min(10, Number(body.limit) || 5));

  const where: Prisma.ExamQuestionWhereInput = {
    difficulty: null,
    transcribedStem: { not: null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      NOT: [
        { examType: "Synthetic" },
        { title: { startsWith: "[Synthetic Bank]" } },
      ],
    },
  };

  const total = await prisma.examQuestion.count({ where });
  const questions = await prisma.examQuestion.findMany({
    where,
    select: {
      id: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      answer: true,
      syllabusTopic: true,
      diagramImageData: true,
      examPaper: { select: { subject: true, level: true, title: true } },
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  if (questions.length === 0) {
    return NextResponse.json({ totalRemaining: 0, processed: 0, updated: 0, results: [] });
  }

  const batch: DifficultyInput[] = questions.map(q => {
    const opts = Array.isArray(q.transcribedOptions)
      ? (q.transcribedOptions as Prisma.JsonArray).filter((v): v is string => typeof v === "string")
      : null;
    const optImgs = Array.isArray(q.transcribedOptionImages)
      ? (q.transcribedOptionImages as Prisma.JsonArray).map(v => typeof v === "string" ? v : null)
      : null;
    return {
      id: q.id,
      stem: q.transcribedStem ?? "",
      options: opts,
      answer: q.answer,
      subject: q.examPaper.subject,
      level: q.examPaper.level,
      syllabusTopic: q.syllabusTopic,
      diagramBase64: q.diagramImageData,
      optionImagesBase64: optImgs && optImgs.some(x => !!x) ? optImgs : null,
    };
  });

  const results: Array<{ id: string; paperTitle: string; difficulty: number | null; reason: string | null; error?: string }> = [];
  try {
    const ratings = await classifyDifficultyBatch(batch);
    for (const q of questions) {
      const r = ratings[q.id];
      if (!r) {
        results.push({ id: q.id, paperTitle: q.examPaper.title, difficulty: null, reason: null, error: "no rating" });
        continue;
      }
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { difficulty: r.difficulty },
      });
      results.push({ id: q.id, paperTitle: q.examPaper.title, difficulty: r.difficulty, reason: r.reason });
    }
  } catch (err) {
    return NextResponse.json({
      totalRemaining: total,
      processed: 0,
      updated: 0,
      results: [],
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }

  return NextResponse.json({
    totalRemaining: total,
    processed: results.length,
    updated: results.filter(r => !r.error).length,
    results,
  });
}

// GET — inventory (how many rated/unrated per subject+level) so the admin
// UI can show progress without running through the whole queue.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const scope: Prisma.ExamQuestionWhereInput = {
    transcribedStem: { not: null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      NOT: [
        { examType: "Synthetic" },
        { title: { startsWith: "[Synthetic Bank]" } },
      ],
    },
  };
  const [total, rated] = await Promise.all([
    prisma.examQuestion.count({ where: scope }),
    prisma.examQuestion.count({ where: { ...scope, difficulty: { not: null } } }),
  ]);
  return NextResponse.json({ total, rated, unrated: total - rated });
}
