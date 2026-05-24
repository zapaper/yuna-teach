import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@/lib/tts";
import { generateWordInfo } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, language, type, expandPunct, voice, pairedText, speedMultiplier } = body;
    // Per-user speed knob applied on top of the base rate. Caller
    // sends 0.5–2.0 (or omits for default 1.0). Clamp to a sensible
    // range so a bad payload can't request silence or DoS the TTS
    // service with 100x-slow audio. Google + Fish both accept any
    // positive multiplier on their underlying speakingRate.
    const speedMul = (() => {
      const n = typeof speedMultiplier === "number" ? speedMultiplier : 1.0;
      if (!Number.isFinite(n)) return 1.0;
      return Math.max(0.5, Math.min(2.0, n));
    })();

    if (!text || !language) {
      return NextResponse.json(
        { error: "Missing text or language" },
        { status: 400 }
      );
    }

    // Return word info (pinyin, meaning, example) as JSON without TTS
    if (type === "wordinfo") {
      const info = await generateWordInfo(text, language, pairedText);
      return NextResponse.json(info);
    }

    // Generate TTS for the meaning sentence
    if (type === "meaning") {
      const info = await generateWordInfo(text, language, pairedText);
      // Chinese + Japanese use the full-width period; Latin-script
      // languages (English, Malay) use ".", Tamil uses Latin "."
      // because Tamil punctuation is mostly Latin in modern usage.
      const speechText =
        language === "CHINESE" || language === "JAPANESE" || language === "KOREAN"
          ? `${info.meaning}。${info.example}`
          : `${info.meaning}. ${info.example}`;

      const audioBuffer = await synthesizeSpeech(speechText, language, { voice, speed: 0.9 * speedMul });
      return new NextResponse(audioBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    }

    // Default: TTS for the word itself
    const audioBuffer = await synthesizeSpeech(text, language, {
      expandPunct: !!expandPunct,
      speed: (expandPunct ? 0.7 : 0.9) * speedMul,
      voice,
    });
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
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
