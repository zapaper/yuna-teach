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
    scorePercent: { type: Type.INTEGER, description: "Score for this segment as a percentage 0-100, snapped to the nearest multiple of 5 (0, 5, 10, ..., 95, 100). 100 = examiner-level answer with no room to improve; 0 = no meaningful answer given." },
    verdict: { type: Type.STRING, description: "One sentence overall verdict for this segment" },
    seabLooksFor: { type: Type.STRING, description: "One sentence: what a PSLE marker rewards under this dimension" },
    details: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 bullet-point observations: what the student did well OR poorly, quoting the transcript" },
    tips: { type: Type.ARRAY, items: DIM_TIP_ITEM, description: "1-3 actionable tips for this dimension" },
    modelUpgrade: { type: Type.STRING, description: "IF scorePercent < 100: a rewritten model answer for THIS segment (Q1 or Q2 or Q3) in a realistic 12-year-old Singaporean voice, applying the moves that were missing. Should be what a top-scoring student would say. IF scorePercent === 100: return an empty string." },
  },
  required: ["scorePercent", "verdict", "seabLooksFor", "details", "tips", "modelUpgrade"],
} as const;

const SCORING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overallVerdict: { type: Type.STRING, description: "Two-sentence overall summary of the student's SBC performance" },
    pictureResponse: DIM_BLOCK,   // Q1 answer quality
    personalResponse: DIM_BLOCK,  // Q2 answer quality
    criticalThinking: DIM_BLOCK,  // Q3 answer quality
  },
  required: ["overallVerdict", "pictureResponse", "personalResponse", "criticalThinking"],
} as const;

const SCORING_PROMPT = `You are marking a PSLE English Paper 4 Stimulus-Based Conversation (SBC).

SBC RUBRIC — 2026 format:

The SBC consists of exactly THREE examiner questions, in order:
  Q1 — Picture Response:   the student comments on the stimulus picture
  Q2 — Personal Response:  the student shares personal experience related to the picture's theme
  Q3 — Critical Thinking:  the student gives a broader opinion / reasoning on the theme

Score each of the student's Q1/Q2/Q3 answers INDEPENDENTLY on a 0–100 percentage scale, snapped to the nearest 5% (0, 5, 10, ..., 95, 100). 100% means an examiner-level answer with essentially nothing to improve. 0% means the student didn't answer or was completely off-topic. 80% is a strong, competent PSLE-band answer with one clear weakness; 60% is passable but missing multiple rubric moves; 40% or below is weak.

WHAT EACH SEGMENT REWARDS:

1. PICTURE RESPONSE (Q1)
   Look for: a concrete detail cited from the picture; a clear stance ("I think…"); a "because" clause that ties the reasoning to what's visible.
   Deduct for: generic "yes it's nice" answers, no reference to the picture, no stated position.

2. PERSONAL RESPONSE (Q2)
   Look for: a specific personal micro-story — named place, named person, or a specific time; a "because" / "as" head; accurate grammar and at least one specific vocabulary choice (say "Orchard Road" not "a mall"; use values vocabulary like "considerate", "appreciate").
   Deduct for: textbook / generic answers, no personal anchor, tense or agreement errors.

3. CRITICAL THINKING (Q3)
   Look for: perspective that goes BEYOND self — mentions "people" / "society" / "others" / a group; a defended opinion; at least one connective ("However", "Furthermore", "Therefore").
   Deduct for: staying purely personal, no stance, or one-word / repetitive answers.

Populate details with 3-5 SPECIFIC observations quoting the student's actual Q1 / Q2 / Q3 answer. Populate tips with 1-3 concrete next-attempt actions per segment (each with 0-4 short quoted examples).

MODEL UPGRADE per segment: If a segment scores below 100%, write a modelUpgrade — what a TOP-scoring PSLE student would have said for THAT specific question given the same stimulus. Realistic 12-year-old Singaporean voice, one short paragraph, includes the moves the student was missing. If scorePercent is 100, return an empty string for modelUpgrade.`;

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
    const parsed = JSON.parse(text) as {
      overallVerdict: string;
      pictureResponse: { scorePercent: number };
      personalResponse: { scorePercent: number };
      criticalThinking: { scorePercent: number };
    };
    // Compute the /25 total from the three segment percentages.
    //   avg = (q1 + q2 + q3) / 3
    //   round to nearest 5% (matches per-segment granularity)
    //   /25 = avg * 25 / 100 = avg / 4
    const snap5 = (n: number) => Math.round(n / 5) * 5;
    const clamp = (n: number) => Math.max(0, Math.min(100, snap5(n)));
    const q1 = clamp(parsed.pictureResponse.scorePercent);
    const q2 = clamp(parsed.personalResponse.scorePercent);
    const q3 = clamp(parsed.criticalThinking.scorePercent);
    const avgPercent = snap5((q1 + q2 + q3) / 3);
    const overallSeabScore = Math.round((avgPercent / 4) * 100) / 100; // /25 to 2dp
    return NextResponse.json({
      ...parsed,
      pictureResponse: { ...parsed.pictureResponse, scorePercent: q1 },
      personalResponse: { ...parsed.personalResponse, scorePercent: q2 },
      criticalThinking: { ...parsed.criticalThinking, scorePercent: q3 },
      overallPercent: avgPercent,
      overallSeabScore,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
