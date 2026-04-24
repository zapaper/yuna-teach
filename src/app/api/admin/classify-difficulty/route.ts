import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import sharp from "sharp";
import { isSessionAdmin } from "@/lib/session";
import { classifyDifficultyBatch, type DifficultyInput } from "@/lib/gemini";

// Shrink a diagram for Gemini vision. Long side 384px, JPEG q65 — small
// enough that a batch of 3 diagrams doesn't time out while still being
// readable to the model.
async function shrinkForClassification(base64: string | null | undefined): Promise<string | null> {
  if (!base64) return null;
  try {
    const clean = base64.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(clean, "base64");
    const out = await sharp(buf)
      .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 65 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return null;
  }
}

// POST — classify the next batch of un-rated master-paper questions.
// Scope: clean-extracted master questions only (transcribedStem NOT NULL,
// sourceExamId NULL, paperType NULL, not a Synthetic Bank paper). Synthetic
// variants inherit their difficulty from the source — handled by GET below.
//
// Batch of 5 per call so a single Gemini round-trip stays under our timeout
// budget and the admin UI can poll incrementally without blocking.
const TEXT_BATCH = 5;
const IMAGE_BATCH = 3;

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  // IDs the admin UI has already tried in this session and got errors on —
  // skip them so the loop doesn't get stuck retrying the same stubborn
  // questions over and over. They stay unrated in DB; admin can trigger
  // them later manually from the clean editor.
  const excludeIds = Array.isArray(body.excludeIds) ? body.excludeIds.filter((x): x is string => typeof x === "string") : [];

  const scope: Prisma.ExamQuestionWhereInput = {
    difficulty: null,
    transcribedStem: { not: null },
    ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    examPaper: {
      sourceExamId: null,
      paperType: null,
      NOT: [
        { examType: "Synthetic" },
        { title: { startsWith: "[Synthetic Bank]" } },
      ],
    },
  };

  const total = await prisma.examQuestion.count({ where: scope });

  // Prefer text-only rows first (batch of 5) — they're fast and drain the
  // bulk of the queue. Only when none remain do we fetch image-bearing
  // rows in batches of 3, which send downscaled diagrams to Gemini's
  // vision path (larger batches reliably time out on real exam papers).
  let questions = await prisma.examQuestion.findMany({
    where: { ...scope, OR: [{ diagramImageData: null }, { diagramImageData: "" }] },
    select: {
      id: true, questionNum: true, examPaperId: true,
      transcribedStem: true, transcribedOptions: true,
      answer: true, syllabusTopic: true, diagramImageData: true,
      examPaper: { select: { subject: true, level: true, title: true } },
    },
    orderBy: { id: "asc" },
    take: TEXT_BATCH,
  });
  let withImages = false;
  if (questions.length === 0) {
    questions = await prisma.examQuestion.findMany({
      where: { ...scope, diagramImageData: { not: null } },
      select: {
        id: true, questionNum: true, examPaperId: true,
        transcribedStem: true, transcribedOptions: true,
        answer: true, syllabusTopic: true, diagramImageData: true,
        examPaper: { select: { subject: true, level: true, title: true } },
      },
      orderBy: { id: "asc" },
      take: IMAGE_BATCH,
    });
    withImages = questions.length > 0;
  }

  if (questions.length === 0) {
    return NextResponse.json({ totalRemaining: 0, processed: 0, updated: 0, results: [] });
  }

  // For image batches, shrink each diagram in parallel before building the
  // Gemini call. Text batches skip this step entirely.
  const shrunk = withImages
    ? await Promise.all(questions.map(q => shrinkForClassification(q.diagramImageData)))
    : questions.map(() => null);

  const batch: DifficultyInput[] = questions.map((q, i) => {
    const opts = Array.isArray(q.transcribedOptions)
      ? (q.transcribedOptions as Prisma.JsonArray).filter((v): v is string => typeof v === "string")
      : null;
    return {
      id: q.id,
      stem: q.transcribedStem ?? "",
      options: opts,
      answer: q.answer,
      subject: q.examPaper.subject,
      level: q.examPaper.level,
      syllabusTopic: q.syllabusTopic,
      diagramBase64: shrunk[i],
      optionImagesBase64: null,
    };
  });

  const results: Array<{ id: string; questionNum: string; paperId: string; paperTitle: string; difficulty: number | null; reason: string | null; error?: string }> = [];
  try {
    const ratings = await classifyDifficultyBatch(batch);
    for (const q of questions) {
      const r = ratings[q.id];
      if (!r) {
        results.push({ id: q.id, questionNum: q.questionNum, paperId: q.examPaperId, paperTitle: q.examPaper.title, difficulty: null, reason: null, error: "no rating" });
        continue;
      }
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { difficulty: r.difficulty },
      });
      results.push({ id: q.id, questionNum: q.questionNum, paperId: q.examPaperId, paperTitle: q.examPaper.title, difficulty: r.difficulty, reason: r.reason });
    }
  } catch (err) {
    // Gemini timeout / 504 / malformed response — surface as per-row errors
    // so the admin UI can show what failed but keep the HTTP status 200.
    // The frontend's continuous loop stops when processed (rows we wrote)
    // is 0, so we won't spin forever on a persistent failure.
    const msg = err instanceof Error ? err.message : String(err);
    for (const q of questions) {
      results.push({ id: q.id, questionNum: q.questionNum, paperId: q.examPaperId, paperTitle: q.examPaper.title, difficulty: null, reason: null, error: msg.slice(0, 120) });
    }
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
