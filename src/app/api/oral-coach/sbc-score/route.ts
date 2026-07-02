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

// SEAB PSLE Paper 4 SBC — 30 marks split across 3 dimensions:
//   Personal Response         12
//   Language Use              12
//   Speaking Style             6
// Rubric is distilled from the SBC analysis Word doc (7 structural
// moves) into three student-facing categories that match the Reading
// Aloud presentation.
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
    overallSeabScore: { type: Type.INTEGER, description: "SEAB /30 total: sum of personalResponse + languageUse + speakingStyle" },
    overallVerdict: { type: Type.STRING, description: "Two-sentence overall summary of the student's SBC performance" },
    personalResponse: DIM_BLOCK,  // /12
    languageUse: DIM_BLOCK,       // /12
    speakingStyle: DIM_BLOCK,     // /6
    modelUpgradeExample: {
      type: Type.STRING,
      description: "Rewrite of the student's weakest single answer in one paragraph, applying the moves that were missing. Realistic 12-year-old voice.",
    },
  },
  required: ["overallSeabScore", "overallVerdict", "personalResponse", "languageUse", "speakingStyle", "modelUpgradeExample"],
} as const;

const SCORING_PROMPT = `You are marking a PSLE English Paper 4 Stimulus-Based Conversation (SBC).

SEAB SBC RUBRIC (30 marks total):

1. PERSONAL RESPONSE (12 marks)
   What SEAB looks for: A clear stance stated up-front, backed by specific reasoning and a concrete personal example (named place, named person, named object, named number). The student should engage genuinely with the prompt rather than giving textbook answers.
   Rubric moves:
   - Stance clarity (0-5): direct one-sentence position stated before elaboration
   - Reason head (0-2): "because"/"as" clause in first two sentences
   - Personal anecdote (0-5): a specific micro-story from the student's life — named place / person / number / physical action

2. LANGUAGE USE (12 marks)
   What SEAB looks for: Accurate grammar, precise vocabulary (specifics over generics), explicit discourse markers connecting ideas, and appropriate register.
   Rubric moves:
   - Grammar accuracy (0-3): tenses, agreements, articles, prepositions
   - Vocabulary specificity (0-4): named things over categories ("Orchard Road" not "a mall"); values vocabulary sprinkled in (considerate, appreciate, widen my horizons)
   - Discourse markers (0-3): 4-6 explicit connectives (Furthermore, However, For example, Therefore, Firstly)
   - Picture engagement (0-2): specific reference to a detail from the stimulus picture with interpretation

3. SPEAKING STYLE (6 marks)
   What SEAB looks for: Natural fluency, appropriate pace, and clear articulation. In transcript-only scoring, judge from evidence of chunking (comma placement, sentence length variety, filler-word density).
   Rubric moves:
   - Fluency (0-3): sentence flow, minimal filler words ("um", "like", "you know")
   - Engagement (0-3): did the student build on the examiner's follow-ups? Give varied sentence structures?

Score each dimension. Populate details with 3-5 SPECIFIC observations quoting the transcript. Populate tips with 1-3 concrete next-attempt actions per dimension, each with 0-4 short quoted examples from the transcript that illustrate the issue.

MODEL UPGRADE: Pick the student's single weakest answer. Rewrite it in one paragraph applying the moves that were missing. Keep the 12-year-old voice — same energy, just tightened.`;

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
