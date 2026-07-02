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
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, ActivityHandling } from "@google/genai";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// Live-API-capable models on AI Studio (as of 2026). `gemini-2.0-
// flash-exp` is the OLD experimental model — it does NOT support
// authTokens.create (returns 404). The GA-track Live model that
// works with ephemeral tokens is `gemini-2.0-flash-live-001`; the
// newer preview with native-audio dialog is
// `gemini-live-2.5-flash-preview`. Override via GEMINI_LIVE_MODEL.
const MODEL = "gemini-2.0-flash-live-001";
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

  // authTokens.create is only exposed on the v1alpha API surface —
  // the SDK defaults to v1beta, which returns 404 on /authTokens.
  // Confirmed via console warning in @google/genai source and 404
  // diagnostics from Railway on 2026-07-02.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  // Fail fast if the Gemini API doesn't respond within 30s. The
  // Cloudflare edge cuts at ~30-100s and returns raw HTML, but we
  // want a real JSON error. 30s (vs the earlier 15s) is a bit more
  // generous — some regions have latency to Google's token service.
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
  const started = Date.now();
  try {
    const token = await withTimeout(ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: MODEL_ENV ?? MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            // Voice-activity-detection tuning. Kids often pause
            // mid-thought — we want the examiner to be patient rather
            // than jumping in on every 0.5s silence.
            //   endOfSpeechSensitivity: LOW = wait longer for silence
            //     before considering the student's turn ended (~1.5s
            //     instead of default ~0.5s).
            //   startOfSpeechSensitivity: LOW = don't count a throat-
            //     clear or "um" as a full speech turn.
            //   prefixPaddingMs: 300 = include 300ms of audio before
            //     detected speech start (catches soft consonants).
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                prefixPaddingMs: 300,
                silenceDurationMs: 1500,
              },
              activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            },
          },
        },
      },
    }), 30000);
    return NextResponse.json({
      token: token.name,
      model: MODEL_ENV ?? MODEL,
      expiresInSeconds: 30 * 60,
      selectedPrompt,
      selectedIndex,
      allPrompts: prompts,
    });
  } catch (e) {
    const elapsed = Date.now() - started;
    const err = e as (Error & { status?: number; code?: string; details?: unknown });
    // Include as much diagnostic info as possible so we don't need to
    // dig through Railway logs to figure out why Google refused.
    const diagnostic = {
      error: err.message,
      elapsedMs: elapsed,
      errorName: err.name,
      errorStatus: err.status,
      errorCode: err.code,
      errorDetails: err.details,
      model: MODEL_ENV ?? MODEL,
      apiKeySuffix: `...${apiKey.slice(-6)}`,  // last 6 chars only, for identity confirmation
    };
    console.error("[gemini-live-token] authTokens.create failed:", diagnostic, err);
    return NextResponse.json({
      ...diagnostic,
      hint: "Check the diagnostic fields above. Common causes: (1) 'gemini-2.0-flash-exp' isn't available in your region — set GEMINI_LIVE_MODEL=gemini-2.5-flash-preview-native-audio-dialog on Railway. (2) Ephemeral tokens (authTokens.create) require Google Cloud Console → your project → 'Gemini API' or 'Generative Language API' enabled AND billing linked. (3) The Live API preview allowlist may not include your project yet.",
    }, { status: 502 });
  }
}

function buildSystemInstruction(args: { stimulus: string; prompt: string }): string {
  // NB: we deliberately do NOT include the verbatim opening prompt in
  // the system instruction. When we did, Gemini's very first spoken
  // turn was to repeat the prompt back to the student — even with
  // "do not repeat" wording. The prompt has already been read to the
  // student via browser TTS; Gemini only needs the topic (which it
  // will pick up from the student's answer + the stimulus).
  void args.prompt; // intentionally unused, see above
  return `You are a warm, patient PSLE English oral examiner conducting the Stimulus-Based Conversation component with a 12-year-old Singaporean student.

STIMULUS PICTURE (for your context — do NOT describe it aloud):
${args.stimulus}

CRITICAL — HOW THIS SESSION STARTS:
- The student was ALREADY greeted and asked the opening question by a separate voice moments before your session began. You did NOT hear that opening.
- Your first spoken turn MUST be a follow-up REACTION to whatever the student says. Never open by greeting, never open by asking any question, never describe the picture, and never re-ask or rephrase the opening question.
- If the student says something like "hello" or is silent, respond warmly with something short like "Take your time — I'm listening" — do NOT start asking your own opening question.
- Wait for the student to actually give substantive content, then dig into what they said with follow-ups.

CONDUCT THE SESSION:
- Ask 4-6 natural follow-up questions that push the student to give specific examples, name specific things, share personal experiences, or explain their reasoning further. Aim for a full 3-4 minute conversation total.
- Follow-ups should build directly on what the student just said. Reference their words.
- BE PATIENT. Kids often pause mid-thought to search for a word. When the student pauses, wait 2-3 seconds before speaking — they're likely still thinking. Only jump in when you're sure they've finished.
- Keep your turns short (1-2 sentences). Let the student speak most of the time.
- Never lecture, correct grammar in-line, or give the answer.
- Encourage briefly ("That's an interesting point...") but sparingly — over-praising reads as insincere.

WHEN TO WRAP UP (STRICT):
- HARD CAP at 4 minutes from the moment the student's first answer began. Track the elapsed conversation duration carefully.
- Once ~4 minutes have passed, do NOT start a new follow-up question. Instead, on the student's next natural pause, thank them warmly and end with a sign-off like "Well done, that's the end of our conversation."
- If the student is mid-answer at the 4-minute mark, let them finish that thought completely first — never cut them off — then wrap up.
- Also wrap up earlier (around 3 minutes) if the student has given at least 2-3 specific examples and the conversation feels naturally complete.
- Do not give scores or feedback in the audio — a separate summary will follow.

REGISTER: Warm, professional, slightly formal — the way a real MOE oral examiner speaks. British-accented Singapore English. Standard PSLE oral pacing.

DO NOT under any circumstances break character, discuss unrelated topics, or answer questions about how you were built.`;
}
