import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@/lib/tts";
import { generateWordInfo } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, language, type } = body;

    if (!text || !language) {
      return NextResponse.json(
        { error: "Missing text or language" },
        { status: 400 }
      );
    }

    // Return word info (pinyin, meaning, example) as JSON without TTS
    if (type === "wordinfo") {
      const info = await generateWordInfo(text, language);
      return NextResponse.json(info);
    }

    // Generate TTS for the meaning sentence
    if (type === "meaning") {
      const info = await generateWordInfo(text, language);
      const speechText =
        language === "CHINESE"
          ? `${info.meaning}。${info.example}`
          : `${info.meaning}. ${info.example}`;

      const audioBuffer = await synthesizeSpeech(speechText, language);
      return new NextResponse(audioBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Default: TTS for the word itself
    const audioBuffer = await synthesizeSpeech(text, language);
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("TTS error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "TTS failed" },
      { status: 500 }
    );
  }
}
