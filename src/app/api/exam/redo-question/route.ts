import { NextRequest, NextResponse } from "next/server";
import { redoQuestionExtraction } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { images, image, questionNum, surroundingQuestions, isFirstInBooklet, previousBoundary } = await request.json();

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
