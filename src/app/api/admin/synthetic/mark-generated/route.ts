import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

// Get or create a synthetic bank paper scoped to a given subject + level +
// question-type. OEQ and MCQ get SEPARATE papers so the daily-quiz / focused-
// test filters can target one or the other. These papers look like normal
// master papers (sourceExamId: null, paperType: null) so question selection
// picks them up naturally.
async function getOrCreateSyntheticBankPaper(
  adminUserId: string,
  subject: string,
  level: string | null,
  questionType: "mcq" | "oeq",
) {
  const suffix = questionType === "oeq" ? " OEQ" : "";
  const title = `[Synthetic Bank]${suffix} ${subject}${level ? " " + level : ""}`;
  const existing = await prisma.examPaper.findFirst({
    where: { title, paperType: null, sourceExamId: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.examPaper.create({
    data: {
      title,
      subject,
      level,
      userId: adminUserId,
      pageCount: 0,
      paperType: null,
      sourceExamId: null,
      extractionStatus: "ready",
      visible: true,
      examType: "Synthetic",
    },
    select: { id: true },
  });
  return created.id;
}

// POST { userId, questionId } → flags source ExamQuestion as syntheticGenerated=true
// and promotes any accepted SyntheticQuestion rows into real ExamQuestion rows in
// the synthetic bank paper for the source's subject+level.
export async function POST(request: NextRequest) {
  const { userId, questionId } = await request.json();
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  const source = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      syllabusTopic: true,
      transcribedSubparts: true,
      examPaper: { select: { subject: true, level: true, examType: true } },
    },
  });
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

  // Detect drawable-shape on the source: either a whole-question `_drawable`
  // sentinel, or any `_subref-<label>` sentinel on a per-subpart canvas. If
  // present, the quiz UI expects a `_drawable` sentinel on the synthetic too
  // so it renders the canvas with the generated diagram as the backdrop.
  function sourceIsDrawable(): boolean {
    const subs = Array.isArray(source?.transcribedSubparts)
      ? (source.transcribedSubparts as Array<{ label?: string }>)
      : [];
    return subs.some((s) => {
      const l = String(s?.label ?? "");
      return l === "_drawable" || l.startsWith("_subref-");
    });
  }
  const drawableSource = sourceIsDrawable();

  const accepted = await prisma.syntheticQuestion.findMany({
    where: { sourceQuestionId: questionId },
    select: {
      variant: true,
      stem: true,
      options: true,
      correctAnswer: true,
      diagramImageData: true,
      questionType: true,
      subparts: true,
      answerText: true,
      marksAvailable: true,
    },
  });

  // Promote MCQ variants and OEQ variants separately — they land in
  // different bank papers.
  const mcqAccepted = accepted.filter((a) => a.questionType !== "oeq");
  const oeqAccepted = accepted.filter((a) => a.questionType === "oeq");

  if (mcqAccepted.length > 0) {
    const bankPaperId = await getOrCreateSyntheticBankPaper(
      userId,
      source.examPaper.subject ?? "Unknown",
      source.examPaper.level ?? null,
      "mcq",
    );
    const existingCount = await prisma.examQuestion.count({ where: { examPaperId: bankPaperId } });
    let nextOrder = existingCount;
    for (const v of mcqAccepted) {
      nextOrder += 1;
      // MCQ variants: 4 options, correctAnswer is 1-4 → store "(N)".
      // Synthesis variants: 1 option (the transformed sentence), stored as
      // the canonical answer text so marking has real ground truth.
      // Image-option MCQ: 4 options that are data URIs → store on the
      // `transcribedOptionImages` field and blank `transcribedOptions`.
      const opts = v.options as unknown as string[];
      const isSynthesis = Array.isArray(opts) && opts.length === 1;
      const hasImgOpts = Array.isArray(opts) && opts.length === 4 && opts.some(o => typeof o === "string" && o.startsWith("data:image/"));
      const answerText = isSynthesis ? (opts[0] ?? "") : `(${v.correctAnswer})`;
      await prisma.examQuestion.create({
        data: {
          questionNum: `S${nextOrder}`,
          imageData: "",
          answer: answerText,
          pageIndex: 0,
          orderIndex: nextOrder,
          marksAvailable: 2,
          examPaperId: bankPaperId,
          syllabusTopic: source.syllabusTopic ?? null,
          transcribedStem: v.stem,
          transcribedOptions: hasImgOpts ? ["", "", "", ""] : (v.options as unknown as string[]),
          transcribedOptionImages: hasImgOpts ? opts : undefined,
          diagramImageData: v.diagramImageData ?? null,
          sourceQuestionId: source.id,
          syntheticSourceExamType: source.examPaper.examType ?? null,
        },
      });
    }
  }

  if (oeqAccepted.length > 0) {
    const bankPaperId = await getOrCreateSyntheticBankPaper(
      userId,
      source.examPaper.subject ?? "Unknown",
      source.examPaper.level ?? null,
      "oeq",
    );
    const existingCount = await prisma.examQuestion.count({ where: { examPaperId: bankPaperId } });
    let nextOrder = existingCount;
    for (const v of oeqAccepted) {
      nextOrder += 1;
      // If the source was drawable (canvas with a diagram backdrop), the
      // student view expects a `_drawable` sentinel to trigger the drawable
      // canvas — inject one carrying the newly-generated diagram.
      const cleanSubs = (v.subparts as unknown) as Array<{ label: string; text: string }> | null;
      const subpartsWithSentinel: Array<{ label: string; text: string; diagramBase64?: string | null }> =
        Array.isArray(cleanSubs) ? [...cleanSubs] : [];
      if (drawableSource && v.diagramImageData) {
        subpartsWithSentinel.push({
          label: "_drawable",
          text: "",
          diagramBase64: v.diagramImageData,
        });
      }
      await prisma.examQuestion.create({
        data: {
          questionNum: `S${nextOrder}`,
          imageData: "",
          answer: v.answerText ?? "",
          pageIndex: 0,
          orderIndex: nextOrder,
          marksAvailable: v.marksAvailable ?? null,
          examPaperId: bankPaperId,
          syllabusTopic: source.syllabusTopic ?? null,
          transcribedStem: v.stem,
          transcribedSubparts: (subpartsWithSentinel as unknown) as Prisma.InputJsonValue,
          diagramImageData: v.diagramImageData ?? null,
          sourceQuestionId: source.id,
          syntheticSourceExamType: source.examPaper.examType ?? null,
        },
      });
    }
  }

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { syntheticGenerated: true },
  });

  return NextResponse.json({ ok: true, promoted: accepted.length });
}
