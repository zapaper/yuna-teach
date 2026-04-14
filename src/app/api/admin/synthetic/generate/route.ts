import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSyntheticMathMcq, generateSyntheticDiagramImage } from "@/lib/gemini";

import { isSessionAdmin } from "@/lib/session";

// POST { userId, questionId } → runs AI and returns { simple, similar } draft variants (not saved)
export async function POST(request: NextRequest) {
  const { userId, questionId, subject } = await request.json() as { userId: string; questionId: string; subject?: "math" | "science" | "english" };
  const subj: "math" | "science" | "english" = subject === "science" || subject === "english" ? subject : "math";
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      diagramImageData: true,
    },
  });
  if (!q || !q.transcribedStem || !q.transcribedOptions) {
    return NextResponse.json({ error: "Question not found or not cleanly transcribed" }, { status: 404 });
  }

  const options = q.transcribedOptions as unknown as string[];
  if (!Array.isArray(options) || options.length !== 4) {
    return NextResponse.json({ error: "Question does not have 4 options" }, { status: 400 });
  }

  const answerNum = parseInt((q.answer ?? "").replace(/[().]/g, "").trim(), 10);
  if (!(answerNum >= 1 && answerNum <= 4)) {
    return NextResponse.json({ error: "Invalid correct answer" }, { status: 400 });
  }

  try {
    const variants = await generateSyntheticMathMcq(
      q.transcribedStem,
      [options[0] ?? "", options[1] ?? "", options[2] ?? "", options[3] ?? ""],
      answerNum,
      q.diagramImageData ?? null,
      subj,
    );

    // If original had a diagram, also generate a fresh diagram image for each variant (in parallel).
    if (q.diagramImageData) {
      const [simpleImg, similarImg] = await Promise.all([
        variants.simple.diagramDescription
          ? generateSyntheticDiagramImage(q.diagramImageData, variants.simple.stem, variants.simple.diagramDescription)
          : Promise.resolve(null),
        variants.similar.diagramDescription
          ? generateSyntheticDiagramImage(q.diagramImageData, variants.similar.stem, variants.similar.diagramDescription)
          : Promise.resolve(null),
      ]);
      variants.simple.diagramImageData = simpleImg;
      variants.similar.diagramImageData = similarImg;
    }

    return NextResponse.json(variants);
  } catch (err) {
    console.error("[synthetic/generate] failed", err);
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}
