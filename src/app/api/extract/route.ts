import { NextRequest, NextResponse } from "next/server";
import { extractWords, extractWordsFromImage } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ocrText, image, guidance } = body;

    let result;
    if (image) {
      // Fast path: image → Gemini in one call (no Google Vision OCR step)
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return NextResponse.json({ error: "Invalid image format" }, { status: 400 });
      }
      result = await extractWordsFromImage(match[2], match[1], guidance);
    } else if (ocrText) {
      result = await extractWords(ocrText, guidance);
    } else {
      return NextResponse.json({ error: "No image or OCR text provided" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Extract error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Extraction failed" },
      { status: 500 }
    );
  }
}
