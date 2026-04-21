import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSyntheticDiagramImage } from "@/lib/gemini";

import { isSessionAdmin } from "@/lib/session";

// POST { sourceQuestionId, variantStem, diagramDescription?, userPrompt?, mode? }
// mode = "reset" → tells the AI to replicate the original diagram as closely as possible (for "simple" variants),
//        otherwise → uses the diagramDescription + admin's userPrompt
export async function POST(request: NextRequest) {
  const { sourceQuestionId, variantStem, diagramDescription, userPrompt, mode } = await request.json();
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!sourceQuestionId || !variantStem) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const source = await prisma.examQuestion.findUnique({
    where: { id: sourceQuestionId },
    select: { diagramImageData: true },
  });
  // Source diagram is optional — OEQ tables describe what to render purely
  // in the description, with no reference image.
  if (mode === "reset" && !source?.diagramImageData) {
    return NextResponse.json({ error: "Source has no diagram to reset from" }, { status: 404 });
  }

  let description: string;
  if (mode === "reset") {
    description = `REPLICATE the reference diagram as closely as possible. Match the layout, line style, labels, and visual structure exactly. Only change numbers/labels where they would conflict with the new question wording. If a value in the reference diagram appears as a number in the new question stem, update that value; otherwise keep it identical to the reference. Do not invent new visual elements that aren't in the reference.`;
  } else {
    description = [diagramDescription, userPrompt && `Additional instructions from admin: ${userPrompt}`]
      .filter(Boolean)
      .join("\n\n") || "Generate a diagram appropriate for this question.";
  }

  const img = await generateSyntheticDiagramImage(source?.diagramImageData ?? null, variantStem, description);
  if (!img) return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  return NextResponse.json({ diagramImageData: img });
}
