import { NextRequest, NextResponse } from "next/server";
import { redoAnswerExtraction } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { image, questionNum } = await request.json();

    if (!image || !questionNum) {
      return NextResponse.json(
        { error: "image and questionNum are required" },
        { status: 400 }
      );
    }

    const base64 = image.replace(/^data:image\/\w+;base64,/, "");
    const result = await redoAnswerExtraction(base64, questionNum);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Redo answer error:", error);
    return NextResponse.json(
      { error: "Failed to re-extract answer" },
      { status: 500 }
    );
  }
}
