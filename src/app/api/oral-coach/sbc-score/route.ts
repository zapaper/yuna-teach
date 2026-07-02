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

const SCORING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    perPromptScores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          promptLabel: { type: Type.STRING },
          stanceClarity: { type: Type.INTEGER },
          reasonHead: { type: Type.INTEGER },
          pictureAnchor: { type: Type.INTEGER },
          anecdoteQuality: { type: Type.INTEGER },
          loopBack: { type: Type.INTEGER },
          valuesVocab: { type: Type.INTEGER },
          discourseMarkers: { type: Type.INTEGER },
          totalOutOf26: { type: Type.INTEGER },
          feedback: { type: Type.STRING },
        },
        required: ["promptLabel", "stanceClarity", "reasonHead", "pictureAnchor",
                   "anecdoteQuality", "loopBack", "valuesVocab", "discourseMarkers",
                   "totalOutOf26", "feedback"],
      },
    },
    overallSeabScore: {
      type: Type.INTEGER,
      description: "Weighted total mapped to the SEAB 30-mark SBC scale.",
    },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    areasToImprove: { type: Type.ARRAY, items: { type: Type.STRING } },
    modelUpgradeExample: {
      type: Type.STRING,
      description: "Pick the student's weakest answer, rewrite it applying the missing structural moves. Concrete, one paragraph.",
    },
  },
  required: ["perPromptScores", "overallSeabScore", "strengths", "areasToImprove", "modelUpgradeExample"],
} as const;

const SCORING_PROMPT = `You are marking a PSLE English Paper 4 Stimulus-Based Conversation.

RUBRIC (26 points, mapped to SEAB's 30-mark scale via x1.15 weighting):
- Stance clarity (0-5): direct one-sentence position stated before elaboration
- Reason head (0-2): "because"/"as" clause in first two sentences
- Picture anchor (0-5): 0=ignored the picture; 3=vague mention; 5=named a specific sub-detail with interpretation
- Anecdote quality (0-5): 5 requires a named place, named person, named number, or specific physical action
- Loop-back closing (0-3): "Therefore"/"For all these reasons" restating the stance
- Values vocabulary (0-3): 2-3 values words per answer (considerate, appreciate, widen my horizons, bond as a family, etc.)
- Discourse markers (0-3): 4-6 explicit connectives (Furthermore, However, For example, Therefore, Firstly)

Score EACH student prompt response (usually three: a, b, c) individually.

MODEL UPGRADE: Pick the student's weakest answer and rewrite it in one paragraph applying the moves that were missing. Make the rewrite realistic for a 12-year-old — same voice, just tightened.`;

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
