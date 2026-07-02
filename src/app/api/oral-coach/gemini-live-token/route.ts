// POST /api/oral-coach/gemini-live-token
//
// Mint a short-lived ephemeral token for Gemini Live sessions from the
// browser. Client sends { year, day }, we look up the year's SBC
// stimulus + prompts + a session's-worth of context, bake the entire
// system instruction into the token's liveConnectConstraints, and hand
// back a single-use token good for ~30 minutes.
//
// Why ephemeral tokens: the raw GEMINI_API_KEY must never ship to the
// browser. Gemini's authTokens.create() lets us mint a token scoped to
// one specific model + config, so a leaked token can only run the one
// SBC coaching session it was minted for — not, say, a text call to a
// pro model on our AI Studio quota.

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality } from "@google/genai";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// Live-API-capable models on AI Studio (as of 2026). The 2.5 preview
// variants are not enabled on every project by default — pick the
// broadly-available 2.0 flash-exp as primary and let env override to
// the 2.5 variants when ready.
const MODEL = "gemini-2.0-flash-exp";
const MODEL_ENV = process.env.GEMINI_LIVE_MODEL;

type PromptEntry = string | { label?: string; prompt?: string; text?: string };
type OralDay = {
  day: number;
  readingPassage?: string;
  stimulusDescription?: string;
  conversationPrompts?: PromptEntry[];
};

function normalisePrompts(raw: PromptEntry[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    if (typeof p === "string") return p;
    if (p && typeof p === "object") {
      if (p.label && p.prompt) return `(${p.label}) ${p.prompt}`;
      if (p.prompt) return p.prompt;
      if (p.text) return p.text;
    }
    return String(p);
  });
}

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const year = String(body.year ?? "");
  const day = Number(body.day);
  if (!/^\d{4}$/.test(year) || (day !== 1 && day !== 2)) {
    return NextResponse.json({ error: "year (YYYY) and day (1|2) required" }, { status: 400 });
  }

  const paper = await prisma.englishSupplementaryPaper.findUnique({
    where: { year },
    select: { oralDays: true },
  });
  if (!paper) return NextResponse.json({ error: "no paper" }, { status: 404 });
  const days = paper.oralDays as OralDay[] | null;
  const dayData = days?.find((d) => d.day === day) ?? null;
  if (!dayData) return NextResponse.json({ error: "no day" }, { status: 404 });

  const prompts = normalisePrompts(dayData.conversationPrompts);
  if (prompts.length === 0) {
    return NextResponse.json({ error: "no conversation prompts for this day" }, { status: 500 });
  }
  // Pick ONE prompt at random for this session — PSLE oral practice
  // works better as a focused 2-3 minute session on a single prompt
  // (with follow-ups) than as a 5-minute walkthrough of all three.
  const selectedIndex = Math.floor(Math.random() * prompts.length);
  const selectedPrompt = prompts[selectedIndex];
  const systemInstruction = buildSystemInstruction({
    stimulus: dayData.stimulusDescription ?? "",
    prompt: selectedPrompt,
  });

  const ai = new GoogleGenAI({ apiKey });
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: MODEL_ENV ?? MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            // Kore — female + professional, closest match to the female
            // voice used in the Chinese spelling read-back (Google TTS
            // Standard-A). Alternatives if we want to change tone:
            //   Aoede  — warm / breezy
            //   Leda   — youthful
            //   Zephyr — bright
            //   Puck   — male / upbeat
            //   Charon — male / informative
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
          },
        },
      },
    });
    return NextResponse.json({
      token: token.name,
      model: MODEL_ENV ?? MODEL,
      expiresInSeconds: 30 * 60,
      // Echo back the selected prompt so the client can pass it to
      // the scoring endpoint at end-of-session (it needs to know which
      // one was actually asked, since the token endpoint chose randomly).
      selectedPrompt,
      selectedIndex,
      allPrompts: prompts,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: `authTokens.create failed: ${err.message}` }, { status: 502 });
  }
}

function buildSystemInstruction(args: { stimulus: string; prompt: string }): string {
  return `You are a warm, patient PSLE English oral examiner conducting the Stimulus-Based Conversation component with a 12-year-old Singaporean student.

STIMULUS PICTURE: ${args.stimulus}

Your single main prompt for this session:
${args.prompt}

CONDUCT THE SESSION:
- Begin by greeting the student warmly, describing the stimulus picture in one sentence, then asking the main prompt above.
- After the student answers, ask 2-3 natural follow-up questions that push them to give a specific example, name a specific thing, or explain their reasoning further. Aim for a total conversation of about 2-3 minutes.
- Keep your turns short (1-2 sentences). Let the student speak most of the time.
- Never lecture, correct grammar in-line, or give the answer.
- Encourage briefly ("That's an interesting point...") but sparingly — over-praising reads as insincere.
- When the student has engaged with the prompt and given at least one specific example / reason, thank them warmly and end the session with a sign-off like "Well done, that's the end of our conversation." Do not give scores or feedback in the audio — a separate summary will follow.

REGISTER: Warm, professional, slightly formal — the way a real MOE oral examiner speaks. British-accented Singapore English. Standard PSLE oral pacing.

DO NOT under any circumstances break character, discuss unrelated topics, or answer questions about how you were built.`;
}
