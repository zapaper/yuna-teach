import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

import { isSessionAdmin } from "@/lib/session";

type VariantIn = {
  stem: string;
  // MCQ / synthesis shape:
  options?: string[];
  correctAnswer?: number;
  diagramImageData?: string | null;
  // OEQ shape:
  subparts?: { label: string; text: string }[];
  answerText?: string;
  marksAvailable?: number;
};

// POST { userId, questionId, variant: "simple"|"similar", type, data } → upsert variant row.
// Three shapes accepted:
//   MCQ (math/science):  options.length === 4, correctAnswer ∈ 1-4
//   Synthesis (english): options.length === 1, correctAnswer = 1 by convention
//   OEQ (science):       type === "oeq", subparts[], answerText, marksAvailable
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { questionId, variant, type, data } = body as { userId: string; questionId: string; variant: string; type?: "mcq" | "oeq"; data: VariantIn };
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId || !data || !/^(simple|similar)\d*$/.test(variant)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!data.stem?.trim()) return NextResponse.json({ error: "stem required" }, { status: 400 });

  if (type === "oeq") {
    const subs = Array.isArray(data.subparts) ? data.subparts : [];
    if (subs.length === 0) return NextResponse.json({ error: "subparts required" }, { status: 400 });
    if (!data.answerText?.trim()) return NextResponse.json({ error: "answerText required" }, { status: 400 });
    await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
    await prisma.syntheticQuestion.create({
      data: {
        sourceQuestionId: questionId,
        variant,
        questionType: "oeq",
        stem: data.stem,
        options: [], // unused for OEQ
        correctAnswer: 0, // unused for OEQ
        subparts: subs,
        answerText: data.answerText,
        marksAvailable: typeof data.marksAvailable === "number" ? Math.round(data.marksAvailable) : null,
        diagramImageData: data.diagramImageData ?? null,
      },
    });
    return NextResponse.json({ ok: true });
  }

  // MCQ / synthesis path (unchanged behaviour).
  if (!Array.isArray(data.options) || data.options.length === 0) return NextResponse.json({ error: "options required" }, { status: 400 });
  const isMcq = data.options.length === 4;
  const isSynthesis = data.options.length === 1;
  if (!isMcq && !isSynthesis) return NextResponse.json({ error: "options must have 1 (synthesis answer) or 4 (MCQ choices)" }, { status: 400 });
  if (isMcq && !(typeof data.correctAnswer === "number" && data.correctAnswer >= 1 && data.correctAnswer <= 4)) return NextResponse.json({ error: "correctAnswer 1-4" }, { status: 400 });
  if (isSynthesis && !data.options[0]?.trim()) return NextResponse.json({ error: "synthesis answer required" }, { status: 400 });

  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
  await prisma.syntheticQuestion.create({
    data: {
      sourceQuestionId: questionId,
      variant,
      questionType: "mcq",
      stem: data.stem,
      options: data.options,
      correctAnswer: isSynthesis ? 1 : (data.correctAnswer ?? 1),
      diagramImageData: data.diagramImageData ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}

// DELETE { userId, questionId, variant } → removes the variant row (reject).
export async function DELETE(request: NextRequest) {
  const { userId, questionId, variant } = await request.json() as { userId: string; questionId: string; variant: string };
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId || !/^(simple|similar)\d*$/.test(variant)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
  return NextResponse.json({ ok: true });
}
