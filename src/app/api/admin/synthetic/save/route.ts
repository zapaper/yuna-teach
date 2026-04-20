import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

import { isSessionAdmin } from "@/lib/session";

type VariantIn = { stem: string; options: string[]; correctAnswer: number; diagramImageData?: string | null };

// POST { userId, questionId, variant: "simple"|"similar", data } → upserts a single variant row.
// Two shapes accepted:
//   MCQ (math/science):  options.length === 4, correctAnswer ∈ 1-4
//   Synthesis (english): options.length === 1 (the transformed-sentence answer),
//                        correctAnswer = 1 by convention
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { userId, questionId, variant, data } = body as { userId: string; questionId: string; variant: string; data: VariantIn };
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Accept "simple", "similar", plus "simpleN"/"similarN" from the Generate-more
  // additional pairs.
  if (!questionId || !data || !/^(simple|similar)\d*$/.test(variant)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!data.stem?.trim()) return NextResponse.json({ error: "stem required" }, { status: 400 });
  if (!Array.isArray(data.options) || data.options.length === 0) return NextResponse.json({ error: "options required" }, { status: 400 });
  const isMcq = data.options.length === 4;
  const isSynthesis = data.options.length === 1;
  if (!isMcq && !isSynthesis) return NextResponse.json({ error: "options must have 1 (synthesis answer) or 4 (MCQ choices)" }, { status: 400 });
  if (isMcq && !(data.correctAnswer >= 1 && data.correctAnswer <= 4)) return NextResponse.json({ error: "correctAnswer 1-4" }, { status: 400 });
  if (isSynthesis && !data.options[0]?.trim()) return NextResponse.json({ error: "synthesis answer required" }, { status: 400 });

  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
  await prisma.syntheticQuestion.create({
    data: {
      sourceQuestionId: questionId,
      variant,
      stem: data.stem,
      options: data.options,
      correctAnswer: isSynthesis ? 1 : data.correctAnswer,
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
