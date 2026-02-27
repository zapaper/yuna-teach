import { NextRequest, NextResponse } from "next/server";
import { analyzeExamPage } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { image, pageIndex, existingQuestions } = await request.json();

    if (!image) {
      return NextResponse.json({ error: "Image is required" }, { status: 400 });
    }

    const base64 = image.replace(/^data:image\/\w+;base64,/, "");
    const analysis = await analyzeExamPage(
      base64,
      pageIndex ?? 0,
      existingQuestions ?? []
    );

    return NextResponse.json(analysis);
  } catch (error) {
    console.error("Page analysis error:", error);
    return NextResponse.json(
      { error: "Failed to analyze page" },
      { status: 500 }
    );
  }
}
