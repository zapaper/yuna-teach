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

// Live-API-capable models. As of 2026-07-02, Google has retired
// the older IDs I originally tried:
//   - gemini-2.0-flash-live-001 (dead)
//   - gemini-live-2.5-flash-preview (dead — retired 2026-03)
//   - gemini-2.0-flash-exp (dead for authTokens)
//   - gemini-2.5-flash-preview-native-audio-dialog (renamed)
// The current working models on v1alpha ephemeral tokens are:
//   - gemini-3.1-flash-live-preview (flagship, native audio, current)
//   - gemini-live-2.5-flash-native-audio (stable fallback)
// Override via GEMINI_LIVE_MODEL env var.
const MODEL = "gemini-3.1-flash-live-preview";
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
  const gender: "male" | "female" = body.gender === "male" ? "male" : "female";
  if (!/^\d{4}$/.test(year) || (day !== 1 && day !== 2)) {
    return NextResponse.json({ error: "year (YYYY) and day (1|2) required" }, { status: 400 });
  }
  // Voice: prefer the per-avatar Gemini voice sent by the client.
  // Whitelist against known-good voice names to avoid Google rejecting
  // the connection for an unknown voice.
  // Voice whitelist. First 10 are the widely-documented safe set;
  // the rest are newer/preview names that may be model-version
  // dependent (some 1008-close if unsupported). Kept opt-in via the
  // per-avatar geminiVoice — if a chosen voice isn't accepted by
  // the current model, the session close reason will explain and
  // we can drop it from the list.
  const VALID_VOICES = new Set([
    "Puck", "Charon", "Kore", "Fenrir", "Aoede",
    "Leda", "Orus", "Zephyr", "Callirrhoe", "Autonoe",
    // Newer / preview additions
    "Achernar", "Achird", "Algenib", "Algieba", "Alnilam",
    "Despina", "Enceladus", "Erinome", "Gacrux", "Iapetus",
    "Laomedeia", "Pulcherrima", "Rasalgethi", "Sadachbia",
    "Sadaltager", "Schedar", "Sulafat", "Umbriel",
    "Vindemiatrix", "Zubenelgenubi",
  ]);
  const requestedVoice = typeof body.geminiVoice === "string" ? body.geminiVoice : "";
  const voiceName = VALID_VOICES.has(requestedVoice)
    ? requestedVoice
    : gender === "male" ? "Charon" : "Callirrhoe";

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
  // New 2026 SBC format: exactly Q1 / Q2 / Q3 asked in order. Q1 is
  // always the picture-response opener (TTS-spoken), Q2 the personal-
  // experience follow-up, Q3 the critical-thinking closer. No random
  // selection, no invention by the model.
  const selectedIndex = 0;
  const selectedPrompt = prompts[0];
  console.log("[gemini-live-token] mint request", { year, day, userId, selectedIndex, gender, voiceName, model: MODEL_ENV ?? MODEL, selectedPrompt: selectedPrompt.slice(0, 80) });
  // Mandatory follow-ups: Q2 then Q3, in that exact order. No
  // random selection, no invention — new 2026 SBC format.
  const mandatoryFollowUps = prompts.slice(1);
  const systemInstruction = buildSystemInstruction({
    stimulus: dayData.stimulusDescription ?? "",
    mandatoryFollowUps,
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
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
            // proactivity.proactiveAudio would let the model stay
            // silent when the user hasn't spoken yet, but it appears
            // to be supported only on gemini-2.5-flash-preview-native-
            // audio-dialog — enabling it on 2.0-flash-live-001 causes
            // the WebSocket to close immediately after handshake with
            // no error text. Client-side gating (studentHasSpokenRef)
            // handles the same problem for now.
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
                // Silence budget before the examiner interjects.
                // User probes on 2026-07-02:
                //   1500 -> "cutting me off"
                //   2500 -> "still cutting me off"
                //   4000 -> "still 2s before jumping in"
                // Bumping to 5000. If Gemini caps silenceDurationMs
                // internally on gemini-3.1-flash-live-preview, we may
                // need to switch to explicit VAD (disable automatic,
                // client-side detects end-of-speech and sends
                // activityEnd) — try that if 5000 still cuts in early.
                silenceDurationMs: 5000,
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
      voiceName,
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

function buildSystemInstruction(args: { stimulus: string; mandatoryFollowUps: string[] }): string {
  // 2026 SBC format: exactly Q1 -> Q2 -> Q3, verbatim, in order.
  // No invention, no paraphrase, no skipping. Q1 was already spoken
  // to the student via TTS. Gemini's job is to ask Q2 after the
  // student's Q1 answer settles, then Q3 after Q2, then wrap up.
  const followUpBlock = args.mandatoryFollowUps.length > 0
    ? `THE TWO FOLLOW-UP QUESTIONS YOU MUST ASK, IN THIS EXACT ORDER:
${args.mandatoryFollowUps.map((p, i) => `  Q${i + 2}. ${p}`).join("\n")}

ASK THESE VERBATIM. Do not paraphrase. Do not invent your own follow-ups. Do not skip either one. Do not add extra questions between them or after Q${args.mandatoryFollowUps.length + 1}.`
    : "";
  return `You are a warm, patient PSLE English oral examiner conducting the Stimulus-Based Conversation (SBC) component with a 12-year-old Singaporean student.

STIMULUS PICTURE (for your context — do NOT describe it aloud):
${args.stimulus}

THE 2026 SBC FORMAT (STRICT):
Every SBC has EXACTLY three examiner questions:
  Q1 — Picture-based (already asked by a separate voice before you joined)
  Q2 — Personal experience related to the picture
  Q3 — Critical thinking on the broader theme

${followUpBlock}

HOW THIS SESSION FLOWS:
1. The student was ALREADY greeted and asked Q1 by a separate voice moments before your session began. You did NOT hear Q1 spoken.
2. Your VERY FIRST spoken turn is a warm reaction to the student's Q1 answer (one sentence: "That's interesting — thanks for sharing"), then immediately ask Q2 VERBATIM as written above.
3. Wait for the student's Q2 answer.
4. After the student finishes Q2, give another one-sentence acknowledgement, then ask Q3 VERBATIM as written above.
5. Wait for the student's Q3 answer.
6. After the student finishes Q3, thank them warmly and end with: "Well done — that's the end of our conversation."

RULES:
- Do NOT greet the student again, describe the picture, or repeat Q1.
- Do NOT invent your own questions. Only ask Q2 and Q3 verbatim.
- Do NOT ask sub-follow-ups between Q2 and Q3, or after Q3. If the student's answer is short, that's fine — move on.
- Do NOT give scores or feedback in the audio — a separate summary will follow.
- BE PATIENT. Wait for the student to FINISH each answer completely before responding — do not interrupt or jump in when they take a 2-3 second breath. The VAD engine waits ~5 seconds of true silence; trust it.
- If the student is silent or says only "hello", say gently "Take your time — I'm listening" ONCE. Do not ask Q2 until they've given a substantive Q1 answer.
- Keep YOUR turns to ONE short sentence (the acknowledgement) plus the verbatim question. Let the student speak the vast majority of the time.
- Never correct grammar in-line or finish the student's sentence for them.

REGISTER: Warm, professional, slightly formal — the way a real MOE oral examiner speaks. British-accented Singapore English. Standard PSLE oral pacing.

DO NOT under any circumstances break character, discuss unrelated topics, or answer questions about how you were built.`;
}
