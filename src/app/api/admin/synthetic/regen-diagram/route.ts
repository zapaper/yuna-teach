import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSyntheticDiagramImage } from "@/lib/gemini";

async function requireAdmin(userId: string | null) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.toLowerCase() === "admin";
}

// POST { userId, sourceQuestionId, variantStem, diagramDescription?, userPrompt? }
// → returns { diagramImageData } (base64) or { error }
export async function POST(request: NextRequest) {
  const { userId, sourceQuestionId, variantStem, diagramDescription, userPrompt } = await request.json();
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!sourceQuestionId || !variantStem) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const source = await prisma.examQuestion.findUnique({
    where: { id: sourceQuestionId },
    select: { diagramImageData: true },
  });
  if (!source?.diagramImageData) return NextResponse.json({ error: "Source has no diagram" }, { status: 404 });

  const description = [diagramDescription, userPrompt && `Additional instructions from admin: ${userPrompt}`]
    .filter(Boolean)
    .join("\n\n");

  const img = await generateSyntheticDiagramImage(source.diagramImageData, variantStem, description || "Generate a diagram appropriate for this question.");
  if (!img) return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  return NextResponse.json({ diagramImageData: img });
}
