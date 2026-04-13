import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

async function requireAdmin(userId: string | null) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.toLowerCase() === "admin";
}

type VariantIn = { stem: string; options: string[]; correctAnswer: number; diagramImageData?: string | null };

// POST { userId, questionId, simple, similar } → saves both variants as SyntheticQuestion rows.
// Replaces any existing rows for that sourceQuestionId so admin can re-accept after edits.
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { userId, questionId, simple, similar } = body as { userId: string; questionId: string; simple: VariantIn; similar: VariantIn };
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId || !simple || !similar) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  function validate(v: VariantIn, label: string) {
    if (!v.stem?.trim()) throw new Error(`${label}: stem required`);
    if (!Array.isArray(v.options) || v.options.length !== 4) throw new Error(`${label}: need 4 options`);
    if (!(v.correctAnswer >= 1 && v.correctAnswer <= 4)) throw new Error(`${label}: correctAnswer 1-4`);
  }
  try {
    validate(simple, "simple");
    validate(similar, "similar");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  await prisma.syntheticQuestion.deleteMany({ where: { sourceQuestionId: questionId } });
  await prisma.syntheticQuestion.createMany({
    data: [
      {
        sourceQuestionId: questionId,
        variant: "simple",
        stem: simple.stem,
        options: simple.options,
        correctAnswer: simple.correctAnswer,
        diagramImageData: simple.diagramImageData ?? null,
      },
      {
        sourceQuestionId: questionId,
        variant: "similar",
        stem: similar.stem,
        options: similar.options,
        correctAnswer: similar.correctAnswer,
        diagramImageData: similar.diagramImageData ?? null,
      },
    ],
  });

  return NextResponse.json({ ok: true });
}
