// POST /api/oral-coach/voice-sample-token
//
// Mint an ephemeral Live token wired to a specific prebuilt voice
// with a minimal system instruction that reads exactly one sample
// sentence. Used by the voice-picker UI on the oral-coach homepage
// so admins can audition every voice against the same script.
//
// Distinct from /api/oral-coach/gemini-live-token because:
//   - no paper/year/day lookup — voice testing shouldn't depend on
//     specific corpus data being ingested
//   - no whitelist on voiceName — the point is to try the less-
//     documented voices too (Enceladus, Iapetus, etc.), and if a
//     given voice ID isn't accepted the session will 1008-close
//     and the client surfaces the reason
//   - system instruction is a strict "read this text and stop"
//     script so the voice speaks reliably on session open

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality } from "@google/genai";
import { isSessionAdmin } from "@/lib/session";

const MODEL = "gemini-3.1-flash-live-preview";
const MODEL_ENV = process.env.GEMINI_LIVE_MODEL;

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const voiceName = typeof body.voiceName === "string" && body.voiceName.length > 0 ? body.voiceName : "Kore";
  const sampleText = typeof body.sampleText === "string" && body.sampleText.length > 0
    ? body.sampleText
    : "Hello! Let's have a chat about this picture. Would you be willing to join a long queue for something? Why or why not?";

  const systemInstruction = `You are a voice-sample synthesiser. When you receive any user message, respond by speaking EXACTLY the following text and then stop. Do not add greetings, questions, or commentary of any kind.

TEXT TO SPEAK:
${sampleText}`;

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: MODEL_ENV ?? MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        },
      },
    });
    console.log("[voice-sample-token] mint", { voiceName, model: MODEL_ENV ?? MODEL });
    return NextResponse.json({ token: token.name, model: MODEL_ENV ?? MODEL, voiceName, sampleText });
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    console.error("[voice-sample-token] failed", { voiceName, error: err.message });
    return NextResponse.json({ error: err.message, voiceName }, { status: 502 });
  }
}
