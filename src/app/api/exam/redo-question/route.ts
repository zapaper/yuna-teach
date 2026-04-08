import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { redoQuestionExtraction } from "@/lib/gemini";
import { prisma } from "@/lib/db";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Redo table extraction for OEQ
    if (body.action === "redo-table" && body.questionId) {
      const q = await prisma.examQuestion.findUnique({
        where: { id: body.questionId },
        select: { questionNum: true, imageData: true, transcribedStem: true },
      });
      if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      if (q.imageData?.startsWith("data:image")) {
        const match = q.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
      parts.push({ text: `Extract the question and any TABLE from this exam question image.

Return the question text in RICH TEXT format:
- If there is a TABLE, reproduce it as a markdown table: | Col1 | Col2 | Col3 |
- Leave blank/empty cells as empty (student fills them in)
- Include pre-filled cells with their text
- If there are checkboxes, use [ ] for empty, [x] for checked
- If there are answer lines, show as [LINES: N]
- Include the full question text before/after the table

${q.transcribedStem ? `Current extracted text (may be missing table):\n${q.transcribedStem}\n\nRe-extract with the table included.` : ""}

Return ONLY the question text with table. No JSON wrapping.` });

      const resp = await getAI().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts }],
        config: { temperature: 0.1 },
      });
      const stem = resp.text?.trim() ?? "";
      console.log(`[Redo Table] Q${q.questionNum}: ${stem.length} chars`);
      return NextResponse.json({ stem });
    }

    const { images, image, questionNum, surroundingQuestions, isFirstInBooklet, previousBoundary } = body;

    // Support both new `images` array and legacy single `image`
    const imageList: string[] = images ?? (image ? [image] : []);

    if (imageList.length === 0 || !questionNum) {
      return NextResponse.json(
        { error: "images and questionNum are required" },
        { status: 400 }
      );
    }

    console.log(
      `[Redo Question API] Re-extracting Q${questionNum} (${imageList.length} page(s))` +
      `, surrounding: [${(surroundingQuestions ?? []).join(", ")}]` +
      (isFirstInBooklet ? " [first in booklet]" : "") +
      (previousBoundary ? ` [after Q${previousBoundary.questionNum} ends at ${previousBoundary.yEndPct}%]` : "")
    );

    const base64List = imageList.map((img: string) =>
      img.replace(/^data:image\/\w+;base64,/, "")
    );
    const result = await redoQuestionExtraction(
      base64List,
      questionNum,
      surroundingQuestions ?? [],
      { isFirstInBooklet, previousBoundary }
    );

    console.log(`[Redo Question API] Q${questionNum} result: pageOffset=${result.pageOffset}, yStartPct=${result.yStartPct}, yEndPct=${result.yEndPct}`);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Redo question error:", error);
    return NextResponse.json(
      { error: "Failed to re-extract question" },
      { status: 500 }
    );
  }
}
