import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  generateSyntheticMathMcq,
  generateSyntheticDiagramImage,
  generateSyntheticOptionImage,
  generateSyntheticScienceOeq,
} from "@/lib/gemini";

import { isSessionAdmin } from "@/lib/session";

// POST { userId, questionId, subject, type } → runs AI and returns
// { simple, similar } draft variants. Not saved to SyntheticQuestion here —
// the admin UI calls /save to persist accepted variants.
export async function POST(request: NextRequest) {
  const { userId, questionId, subject, type } = await request.json() as {
    userId: string;
    questionId: string;
    subject?: "math" | "science" | "english";
    type?: "mcq" | "oeq";
  };
  const subj: "math" | "science" | "english" = subject === "science" || subject === "english" ? subject : "math";
  const qtype: "mcq" | "oeq" = type === "oeq" ? "oeq" : "mcq";
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedSubparts: true,
      marksAvailable: true,
      syllabusTopic: true,
      answer: true,
      diagramImageData: true,
    },
  });
  if (!q || !q.transcribedStem) {
    return NextResponse.json({ error: "Question not found or not cleanly transcribed" }, { status: 404 });
  }

  // OEQ branch: multi-subpart, command-word-aware. Much simpler than MCQ —
  // no image options and no MCQ answer-index validation.
  if (qtype === "oeq") {
    const subs = Array.isArray(q.transcribedSubparts) ? (q.transcribedSubparts as unknown as Array<{ label?: string; text?: string }>) : [];
    const cleanSubs = subs
      .map((s) => ({ label: String(s?.label ?? ""), text: String(s?.text ?? "") }))
      .filter((s) => s.label && s.text);
    if (cleanSubs.length === 0) {
      return NextResponse.json({ error: "OEQ source has no usable subparts" }, { status: 400 });
    }
    if (!q.answer || !q.answer.trim()) {
      return NextResponse.json({ error: "OEQ source has no marking scheme" }, { status: 400 });
    }
    try {
      const variants = await generateSyntheticScienceOeq(
        q.transcribedStem,
        cleanSubs,
        q.answer,
        q.marksAvailable ?? 0,
        q.syllabusTopic ?? null,
        q.diagramImageData ?? null,
      );

      // Generate a fresh diagram/table for each variant if the AI returned a
      // description — source diagram is optional (tables, for instance,
      // describe a pure-text→image render with no reference needed).
      const [simpleDiag, similarDiag] = await Promise.all([
        variants.simple.diagramDescription
          ? generateSyntheticDiagramImage(q.diagramImageData ?? null, variants.simple.stem, variants.simple.diagramDescription)
          : Promise.resolve(null),
        variants.similar.diagramDescription
          ? generateSyntheticDiagramImage(q.diagramImageData ?? null, variants.similar.stem, variants.similar.diagramDescription)
          : Promise.resolve(null),
      ]);
      variants.simple.diagramImageData = simpleDiag;
      variants.similar.diagramImageData = similarDiag;
      return NextResponse.json({ type: "oeq", ...variants });
    } catch (err) {
      console.error("[synthetic/generate oeq] failed", err);
      return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
    }
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
