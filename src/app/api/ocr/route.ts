import { NextRequest, NextResponse } from "next/server";
import { performOCR } from "@/lib/vision";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { image } = body;

    if (!image) {
      return NextResponse.json(
        { error: "No image provided" },
        { status: 400 }
      );
    }

    // Strip data URL prefix if present
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const text = await performOCR(base64Data);

    return NextResponse.json({ text });
  } catch (error) {
    console.error("OCR error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "OCR failed" },
      { status: 500 }
    );
  }
}
