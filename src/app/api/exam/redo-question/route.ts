import { NextRequest, NextResponse } from "next/server";
import { redoQuestionExtraction } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { image, questionNum, surroundingQuestions, isFirstInBooklet, previousBoundary } = await request.json();

    if (!image || !questionNum) {
      return NextResponse.json(
        { error: "image and questionNum are required" },
        { status: 400 }
      );
    }

    console.log(
      `[Redo Question API] Re-extracting Q${questionNum}` +
      `, surrounding: [${(surroundingQuestions ?? []).join(", ")}]` +
      (isFirstInBooklet ? " [first in booklet]" : "") +
      (previousBoundary ? ` [after Q${previousBoundary.questionNum} ends at ${previousBoundary.yEndPct}%]` : "")
    );

    const base64 = image.replace(/^data:image\/\w+;base64,/, "");
    const result = await redoQuestionExtraction(
      base64,
      questionNum,
      surroundingQuestions ?? [],
      { isFirstInBooklet, previousBoundary }
    );

    console.log(`[Redo Question API] Q${questionNum} result: yStartPct=${result.yStartPct}, yEndPct=${result.yEndPct}`);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Redo question error:", error);
    return NextResponse.json(
      { error: "Failed to re-extract question" },
      { status: 500 }
    );
  }
}
