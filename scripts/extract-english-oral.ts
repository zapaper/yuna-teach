// Structure each year's Paper 4 OCR into the shape the Oral Coach UI
// consumes. Reads EnglishSupplementaryPaper.paper4Text (raw OCR) and
// paper4AnswerText (mixed-bag answers blob) for each row, prompts
// Gemini to emit a structured JSON, then writes:
//   oralDays          — [{ day, readingPassage, stimulusDescription,
//                         conversationPrompts: [{ label, prompt }] }]
//   oralModelAnswers  — [{ day, q, answer }]  (only for rows where
//                         paper4AnswerContentKind='sbc_model_answers';
//                         'partial_sbc' rows attempted with lower conf,
//                         other kinds skipped for model answers)
//
// The Paper 4 corpus (2016-2025) has a consistent structure per PDF:
//   Day 1 reading passage → Day 1 SBC picture → Day 1 SBC prompts
//   Day 2 reading passage → Day 2 SBC picture → Day 2 SBC prompts
// Section markers already in the OCR ("READING PASSAGE",
// "STIMULUS-BASED CONVERSATION", "Notes to Examiners", "(a)/(b)/(c)")
// give Gemini enough anchors to split cleanly.
//
// Usage:
//   npx tsx scripts/extract-english-oral.ts --dry              # all years, dry-run
//   npx tsx scripts/extract-english-oral.ts --year 2024        # single year
//   npx tsx scripts/extract-english-oral.ts                    # all years, real write
//   npx tsx scripts/extract-english-oral.ts --force            # overwrite already-extracted rows

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const yearArgIdx = process.argv.indexOf("--year");
const YEAR_FILTER = yearArgIdx >= 0 ? process.argv[yearArgIdx + 1] : null;

const MODEL = "gemini-3.1-pro-preview";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
  httpOptions: { timeout: 180000 },
});

const EXTRACTION_PROMPT = `You are extracting structured PSLE English Paper 4 (Oral) content from raw OCR text.

The Oral exam is administered over 2 days. Each day has:
  1. A Reading Passage (a short story or descriptive text the student reads aloud)
  2. A stimulus picture (described in the OCR as "[Picture: <description>]")
  3. Three conversation prompts labelled (a), (b), (c) for the examiner to ask

The OCR includes clear section markers:
  - "READING PASSAGE"                      → start of Component 1 for a day
  - "STIMULUS-BASED CONVERSATION"          → the picture stimulus for that day
  - "STIMULUS-BASED CONVERSATION PROMPTS"  → the (a)/(b)/(c) prompts for that day
  - "Notes to Examiners:"                  → precedes the prompts (skip these notes)

If model answers are provided (from a tutor-published PDF), they'll be under headers like
"PAPER 4", "STIMULUS-BASED CONVERSATION", "Day 1", "Day 2", "(a)/(b)/(c)". If the answers
blob contains "Based on the recording" content, that's Paper 3 listening (WRONG — ignore).

Return JSON exactly matching this shape:
{
  "days": [
    {
      "day": 1,
      "readingPassage": "<the full reading passage text for day 1, cleanly extracted, no page markers or **bold** markdown>",
      "stimulusDescription": "<the picture description for day 1, e.g. 'A long queue of people waiting in front of an ice-cream cart under an umbrella.'>",
      "conversationPrompts": [
        { "label": "a", "prompt": "<prompt a text>" },
        { "label": "b", "prompt": "<prompt b text>" },
        { "label": "c", "prompt": "<prompt c text>" }
      ]
    },
    {
      "day": 2,
      "readingPassage": "...",
      "stimulusDescription": "...",
      "conversationPrompts": [ ... ]
    }
  ],
  "modelAnswers": [
    { "day": 1, "q": "a", "answer": "<full model response as one paragraph>" },
    { "day": 1, "q": "b", "answer": "..." },
    { "day": 1, "q": "c", "answer": "..." },
    { "day": 2, "q": "a", "answer": "..." },
    ... etc
  ]
}

Rules:
- If only Day 1 is present (some years only have 1 day in the OCR), return days: [{day:1, ...}] only.
- If no model answers are present, return modelAnswers: [].
- If model answers are only for some prompts (e.g. only Day 1 (a) and (b)), include only those and skip the rest.
- Strip "**" bold markers and "*italic*" markers from the extracted text — plain prose only.
- Do NOT invent content. If a section is missing from the OCR, omit it.`;

type ExtractedResult = {
  days: Array<{
    day: number;
    readingPassage: string;
    stimulusDescription: string;
    conversationPrompts: Array<{ label: string; prompt: string }>;
  }>;
  modelAnswers: Array<{ day: number; q: string; answer: string }>;
};

async function extractForYear(row: {
  year: string;
  paper4Text: string;
  paper4AnswerText: string | null;
  paper4AnswerContentKind: string | null;
}): Promise<ExtractedResult> {
  const includeAnswers =
    row.paper4AnswerContentKind === "sbc_model_answers" ||
    row.paper4AnswerContentKind === "partial_sbc";
  const parts: string[] = [];
  parts.push(EXTRACTION_PROMPT);
  parts.push("");
  parts.push(`=== YEAR: ${row.year} ===`);
  parts.push("");
  parts.push("--- Paper 4 OCR (reading passage + SBC prompts) ---");
  parts.push(row.paper4Text);
  if (includeAnswers && row.paper4AnswerText) {
    parts.push("");
    parts.push("--- Model-answers blob (may include model responses to prompts) ---");
    parts.push(row.paper4AnswerText);
  }
  const prompt = parts.join("\n");
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });
  const text = response.text;
  if (!text) throw new Error(`Gemini returned empty response for ${row.year}`);
  const parsed = JSON.parse(text) as ExtractedResult;
  return parsed;
}

function summarise(r: ExtractedResult): string {
  const daySum = r.days.map((d) => {
    const rp = d.readingPassage?.length ?? 0;
    const sd = d.stimulusDescription?.length ?? 0;
    const nPrompts = d.conversationPrompts?.length ?? 0;
    return `Day${d.day}(rp=${rp}c, stim=${sd}c, ${nPrompts}prompts)`;
  }).join(" ");
  const modelCount = r.modelAnswers?.length ?? 0;
  return `${daySum} | ${modelCount} model answers`;
}

(async () => {
  const where: { paper4Text: { not: null }; year?: string } = { paper4Text: { not: null } };
  if (YEAR_FILTER) where.year = YEAR_FILTER;
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where,
    orderBy: { year: "desc" },
    select: {
      id: true, year: true,
      paper4Text: true, paper4AnswerText: true, paper4AnswerContentKind: true,
      oralDays: true, oralModelAnswers: true,
    },
  });
  console.log(`${rows.length} candidate year${rows.length === 1 ? "" : "s"}${YEAR_FILTER ? ` (--year ${YEAR_FILTER})` : ""} | dry=${DRY} | force=${FORCE}`);
  console.log();

  let done = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const alreadyDone = row.oralDays !== null;
    if (alreadyDone && !FORCE) {
      console.log(`  ${row.year}  SKIP (already has oralDays; pass --force to overwrite)`);
      skipped++;
      continue;
    }
    try {
      const result = await extractForYear({
        year: row.year,
        paper4Text: row.paper4Text!,
        paper4AnswerText: row.paper4AnswerText,
        paper4AnswerContentKind: row.paper4AnswerContentKind,
      });
      console.log(`  ${row.year}  ${DRY ? "[DRY]" : "OK  "}  ${summarise(result)}`);
      if (!DRY) {
        await prisma.englishSupplementaryPaper.update({
          where: { id: row.id },
          data: {
            oralDays: result.days as unknown as object,
            oralModelAnswers: result.modelAnswers.length > 0
              ? (result.modelAnswers as unknown as object)
              : undefined,  // don't overwrite an existing non-empty oralModelAnswers with []
          },
        });
      }
      done++;
    } catch (e) {
      const err = e as Error;
      console.log(`  ${row.year}  FAIL  ${err.message.slice(0, 120)}`);
      failed++;
    }
  }
  console.log();
  console.log(`Summary: ${done} ok, ${skipped} skipped, ${failed} failed`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
