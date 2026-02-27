import { NextRequest, NextResponse } from "next/server";
import { extractExamAnswers } from "@/lib/gemini";

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
    const answers = await extractExamAnswers(base64Images);

    return NextResponse.json({ answers });
  } catch (error) {
    console.error("Answer extraction error:", error);
    return NextResponse.json(
      { error: "Failed to extract answers" },
      { status: 500 }
    );
  }
}
