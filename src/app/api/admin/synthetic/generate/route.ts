import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSyntheticMathMcq, generateSyntheticDiagramImage, generateSyntheticOptionImage } from "@/lib/gemini";

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
      transcribedOptionImages: true,
      answer: true,
      diagramImageData: true,
    },
  });
  if (!q || !q.transcribedStem) {
    return NextResponse.json({ error: "Question not found or not cleanly transcribed" }, { status: 404 });
  }

  const textOptions = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as unknown as string[]) : null;
  const imageOptions = Array.isArray(q.transcribedOptionImages) ? (q.transcribedOptionImages as unknown as (string | null)[]) : null;
  const hasTextOpts = textOptions && textOptions.length === 4 && textOptions.some(o => (o ?? "").trim());
  const hasImageOpts = imageOptions && imageOptions.length === 4 && imageOptions.some(o => !!o);

  if (!hasTextOpts && !hasImageOpts) {
    return NextResponse.json({ error: "Question has no usable options (neither text nor images)" }, { status: 400 });
  }

  const answerNum = parseInt((q.answer ?? "").replace(/[().]/g, "").trim(), 10);
  if (!(answerNum >= 1 && answerNum <= 4)) {
    return NextResponse.json({ error: "Invalid correct answer" }, { status: 400 });
  }

  try {
    const variants = await generateSyntheticMathMcq(
      q.transcribedStem,
      hasTextOpts
        ? [textOptions![0] ?? "", textOptions![1] ?? "", textOptions![2] ?? "", textOptions![3] ?? ""]
        : ["", "", "", ""],
      answerNum,
      q.diagramImageData ?? null,
      subj,
      hasImageOpts ? imageOptions : null,
    );

    // Fresh diagram image (stem-adjacent), if the source had one. Run in parallel
    // with the option-image generation below.
    const diagramPromise = q.diagramImageData
      ? Promise.all([
          variants.simple.diagramDescription
            ? generateSyntheticDiagramImage(q.diagramImageData, variants.simple.stem, variants.simple.diagramDescription)
            : Promise.resolve(null),
          variants.similar.diagramDescription
            ? generateSyntheticDiagramImage(q.diagramImageData, variants.similar.stem, variants.similar.diagramDescription)
            : Promise.resolve(null),
        ])
      : Promise.resolve([null, null]);

    // Fresh option images per variant when the source used image options.
    // Use the matching original option image as style reference for each slot.
    // Wrap raw base64 returns as data URIs so downstream code (admin page,
    // storage packing) can detect them consistently.
    async function genOptionImages(v: typeof variants.simple): Promise<(string | null)[] | undefined> {
      if (!hasImageOpts || !v.optionImageDescriptions) return undefined;
      const results = await Promise.all(
        v.optionImageDescriptions.map((desc, i) =>
          generateSyntheticOptionImage(imageOptions![i] ?? null, desc, v.stem)
        )
      );
      return results.map(b64 => (b64 ? (b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`) : null));
    }

    const [[simpleDiag, similarDiag], simpleOpts, similarOpts] = await Promise.all([
      diagramPromise,
      genOptionImages(variants.simple),
      genOptionImages(variants.similar),
    ]);
    variants.simple.diagramImageData = simpleDiag;
    variants.similar.diagramImageData = similarDiag;
    if (simpleOpts) variants.simple.optionImages = simpleOpts;
    if (similarOpts) variants.similar.optionImages = similarOpts;

    return NextResponse.json(variants);
  } catch (err) {
    console.error("[synthetic/generate] failed", err);
    return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
  }
}
