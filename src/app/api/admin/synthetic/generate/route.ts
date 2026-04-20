import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSyntheticMathMcq, generateSyntheticDiagramImage, generateSyntheticSynthesis } from "@/lib/gemini";

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
  if (!q || !q.transcribedStem) {
    return NextResponse.json({ error: "Question not found or not cleanly transcribed" }, { status: 404 });
  }

  // English subject = Synthesis & Transformation generation (written answers,
  // no options, keyword-driven). Different pipeline entirely.
  if (subj === "english") {
    if (!q.answer) return NextResponse.json({ error: "Missing original answer" }, { status: 400 });
    try {
      const variants = await generateSyntheticSynthesis(q.transcribedStem, q.answer);
      return NextResponse.json({
        simple:  { stem: variants.simple.stem,  options: ["", "", "", ""], correctAnswer: 0, answer: variants.simple.answer,  keyword: variants.simple.keyword },
        similar: { stem: variants.similar.stem, options: ["", "", "", ""], correctAnswer: 0, answer: variants.similar.answer, keyword: variants.similar.keyword },
      });
    } catch (err) {
      console.error("[synthetic/generate] English synthesis failed", err);
      return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
    }
  }

  if (!q.transcribedOptions) {
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
