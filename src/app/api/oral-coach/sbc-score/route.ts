// POST /api/oral-coach/sbc-score
//
// After the Gemini Live SBC session ends, the client posts the full
// transcript (student turns + examiner turns interleaved) here. We ask
// a text-only Gemini call to score the student's responses against the
// SEAB SBC rubric distilled in scripts/_build-sbc-analysis-doc.ts
// (structural formula + content moves + values vocab).
//
// Separating scoring from the Live session keeps the live audio session
// focused on running the conversation (no meta-work in the audio path)
// and lets us use a stronger model (gemini-3.1-pro) for the analysis.

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import { getSessionUserId } from "@/lib/session";

const MODEL = "gemini-3.1-pro-preview";

type TranscriptTurn = { speaker: "examiner" | "student"; text: string; ts?: number };

// SEAB PSLE Paper 4 SBC — 25 marks (updated 2026-07-02 per new
// examiner rubric on psleprep.sg) split across 3 dimensions that
// mirror the 3 mandatory question types:
//   Picture Response          10   (Q1: what do you see / interpret)
//   Personal Response         10   (Q2: personal experience linked)
//   Critical Thinking          5   (Q3: broader opinion / reasoning)
// One dimension per question type — score reflects how the student
// engaged with THAT question, not just overall performance.
const DIM_TIP_ITEM = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING, description: "Short specific issue label, e.g. 'Weak stance'" },
    hint: { type: Type.STRING, description: "1-2 sentences of concrete advice a student can act on next attempt" },
    examples: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "0-4 direct quotes from the student's transcript that show this issue",
    },
  },
  required: ["label", "hint", "examples"],
} as const;
const DIM_BLOCK = {
  type: Type.OBJECT,
  properties: {
    scoreOutOf: { type: Type.INTEGER, description: "The student's mark for this SEAB dimension" },
    verdict: { type: Type.STRING, description: "One sentence overall verdict for this dimension" },
    seabLooksFor: { type: Type.STRING, description: "One sentence: what a PSLE marker rewards under this dimension" },
    details: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 bullet-point observations: what the student did well OR poorly, quoting the transcript" },
    tips: { type: Type.ARRAY, items: DIM_TIP_ITEM, description: "1-3 actionable tips for this dimension" },
  },
  required: ["scoreOutOf", "verdict", "seabLooksFor", "details", "tips"],
} as const;

const SCORING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overallSeabScore: { type: Type.INTEGER, description: "SEAB /25 total: sum of pictureResponse + personalResponse + criticalThinking" },
    overallVerdict: { type: Type.STRING, description: "Two-sentence overall summary of the student's SBC performance" },
    pictureResponse: DIM_BLOCK,   // /10 — Q1 answer quality
    personalResponse: DIM_BLOCK,  // /10 — Q2 answer quality
    criticalThinking: DIM_BLOCK,  // /5  — Q3 answer quality
    modelUpgradeExample: {
      type: Type.STRING,
      description: "Rewrite of the student's weakest single answer in one paragraph, applying the moves that were missing. Realistic 12-year-old voice.",
    },
  },
  required: ["overallSeabScore", "overallVerdict", "pictureResponse", "personalResponse", "criticalThinking", "modelUpgradeExample"],
} as const;

const SCORING_PROMPT = `You are marking a PSLE English Paper 4 Stimulus-Based Conversation (SBC).

SEAB SBC RUBRIC (25 marks total, updated 2026):

The SBC consists of exactly THREE examiner questions, in order:
  Q1 — Picture Response:   the student comments on the stimulus picture
  Q2 — Personal Response:  the student shares personal experience related to the picture's theme
  Q3 — Critical Thinking:  the student gives a broader opinion / reasoning on the theme

Score each of the student's Q1/Q2/Q3 answers independently against these dimensions:

1. PICTURE RESPONSE (10 marks — Q1)
   What SEAB looks for: Does the student engage specifically with what's in the picture? Do they identify concrete details (named objects, actions, scenes) and offer a reasoned interpretation, not just a generic "yes it's nice"?
   Rubric moves:
   - Concrete picture detail cited (0-3): names something visible (a person, object, activity)
   - Clear stance stated (0-3): direct position with "I think..." or equivalent
   - Reasoning grounded in the picture (0-4): "because" clause that ties back to what's in the picture

2. PERSONAL RESPONSE (10 marks — Q2)
   What SEAB looks for: A specific personal experience with named place / person / number / physical action, told at 12-year-old-authentic level. NOT a textbook answer.
   Rubric moves:
   - Personal anecdote (0-5): a specific micro-story — named place, named person, or specific time
   - Reason head (0-2): "because" / "as" clause in first two sentences
   - Language use in the answer (0-3): accurate grammar + at least one specific vocabulary choice (Orchard Road not "a mall"; considerate / appreciate / etc.)

3. CRITICAL THINKING (5 marks — Q3)
   What SEAB looks for: An opinion that goes BEYOND personal experience — the student weighs broader implications, mentions society / community / values, and defends the view.
   Rubric moves:
   - Broader-than-self perspective (0-2): mentions "people" / "society" / "others" / a group
   - Defended opinion (0-2): a clear stance backed by at least one reason
   - Discourse markers (0-1): a connective like "However", "Furthermore", "Therefore"

Score each dimension. Populate details with 3-5 SPECIFIC observations quoting the student's Q1 (for pictureResponse) / Q2 (for personalResponse) / Q3 (for criticalThinking) answer. Populate tips with 1-3 concrete next-attempt actions per dimension, each with 0-4 short quoted examples.

MODEL UPGRADE: Pick the student's single weakest Q-answer (Q1 / Q2 / Q3). Rewrite it in one paragraph applying the moves that were missing. Keep the 12-year-old voice — same energy, just tightened.`;

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const transcript = body.transcript as TranscriptTurn[] | undefined;
  const stimulus = String(body.stimulus ?? "");
  const prompts = (body.prompts as string[] | undefined) ?? [];
  if (!Array.isArray(transcript) || transcript.length < 2) {
    return NextResponse.json({ error: "transcript array with at least 2 turns required" }, { status: 400 });
  }

  const transcriptText = transcript
    .map((t) => `${t.speaker === "examiner" ? "EXAMINER" : "STUDENT"}: ${t.text}`)
    .join("\n\n");

  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${SCORING_PROMPT}\n\nSTIMULUS: ${stimulus}\n\nPROMPTS:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nTRANSCRIPT:\n${transcriptText}`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: SCORING_SCHEMA,
        temperature: 0.2,
      },
    });
    const text = response.text;
    if (!text) throw new Error("empty response");
    return NextResponse.json(JSON.parse(text));
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
