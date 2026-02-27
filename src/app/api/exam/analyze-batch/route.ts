import { NextRequest, NextResponse } from "next/server";
import { analyzeExamBatch } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { images } = await request.json();

    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json(
        { error: "At least one image is required" },
        { status: 400 }
      );
    }

    const base64Images = images.map((img: string) =>
      img.replace(/^data:image\/\w+;base64,/, "")
    );

    const result = await analyzeExamBatch(base64Images);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Batch analysis error:", error);
    return NextResponse.json(
      { error: "Failed to analyze exam paper" },
      { status: 500 }
    );
  }
}
