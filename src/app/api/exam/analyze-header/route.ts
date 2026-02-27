import { NextRequest, NextResponse } from "next/server";
import { analyzeExamHeader } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const { image } = await request.json();

    if (!image) {
      return NextResponse.json({ error: "Image is required" }, { status: 400 });
    }

    const base64 = image.replace(/^data:image\/\w+;base64,/, "");
    const header = await analyzeExamHeader(base64);

    return NextResponse.json(header);
  } catch (error) {
    console.error("Header analysis error:", error);
    return NextResponse.json(
      { error: "Failed to analyze header" },
      { status: 500 }
    );
  }
}
