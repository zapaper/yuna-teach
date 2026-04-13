import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

async function requireAdmin(userId: string | null) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.toLowerCase() === "admin";
}

type VariantIn = { stem: string; options: string[]; correctAnswer: number; diagramImageData?: string | null };

// POST { userId, questionId, variant: "simple"|"similar", data } → upserts a single variant row.
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { userId, questionId, variant, data } = body as { userId: string; questionId: string; variant: "simple" | "similar"; data: VariantIn };
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId || !data || (variant !== "simple" && variant !== "similar")) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!data.stem?.trim()) return NextResponse.json({ error: "stem required" }, { status: 400 });
  if (!Array.isArray(data.options) || data.options.length !== 4) return NextResponse.json({ error: "need 4 options" }, { status: 400 });
  if (!(data.correctAnswer >= 1 && data.correctAnswer <= 4)) return NextResponse.json({ error: "correctAnswer 1-4" }, { status: 400 });

  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
  await prisma.syntheticQuestion.create({
    data: {
      sourceQuestionId: questionId,
      variant,
      stem: data.stem,
      options: data.options,
      correctAnswer: data.correctAnswer,
      diagramImageData: data.diagramImageData ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}

// DELETE { userId, questionId, variant } → removes the variant row (reject).
export async function DELETE(request: NextRequest) {
  const { userId, questionId, variant } = await request.json();
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId || (variant !== "simple" && variant !== "similar")) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId, variant } });
  return NextResponse.json({ ok: true });
}
