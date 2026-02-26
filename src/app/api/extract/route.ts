import { NextRequest, NextResponse } from "next/server";
import { extractWords } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ocrText } = body;

    if (!ocrText) {
      return NextResponse.json(
        { error: "No OCR text provided" },
        { status: 400 }
      );
    }

    const result = await extractWords(ocrText);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Extract error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Extraction failed" },
      { status: 500 }
    );
  }
}
