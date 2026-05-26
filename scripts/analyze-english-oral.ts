// PSLE English Oral (Paper 4) analysis — Stimulus-Based Conversation
// (SBC) across 2016-2025.
//
// Inputs: EnglishSupplementaryPaper rows (oralDays = reading passage +
// stimulus description (+ Gemini-enriched richDescription if the admin
// has run the enrich-sbc endpoint) + conversation prompts; oralModelAnswers
// = the 6 SBC model answers per year, 3 per day).
//
// Outputs (cached, re-runnable):
//   - scripts/eng-oral-themes.json     — SBC topic heatmap + prediction
//   - scripts/eng-oral-techniques.json — PEEL / sentence-starter analysis
//
// Then build-english-oral-docx.ts builds the final Word doc.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";

const MODEL = "gemini-3.1-pro-preview";
const SCRIPT_DIR = __dirname;
const THEMES_CACHE = path.join(SCRIPT_DIR, "eng-oral-themes.json");
const TECHNIQUES_CACHE = path.join(SCRIPT_DIR, "eng-oral-techniques.json");

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (let i = 1; i <= 3; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      if (![504, 503, 429, 500].includes(status as number) || i === 3) break;
      const wait = 5000 * i;
      console.warn(`[${label}] ${status} attempt ${i}/3, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

type OralDay = {
  day: 1 | 2;
  readingPassage?: string;
  stimulusDescription?: string;
  richDescription?: string | null;
  conversationPrompts?: string[];
};
type OralModelAnswer = { day: 1 | 2; q: string; answer: string };
type Row = {
  year: string;
  oralDays: OralDay[];
  oralModelAnswers: OralModelAnswer[];
};

type OralTheme = {
  name: string;           // e.g. "Healthy lifestyle / fitness"
  description: string;
  yearsAppeared: Array<{ year: string; day: 1 | 2; note: string }>;
  frequency: number;
};
type ThemesOutput = {
  overview: string;
  prediction: string;            // 2-3 sentences citing year evidence
  themes: OralTheme[];
};

type PeelBreakdown = {
  questionType: string;           // e.g. "Would you participate in this activity?"
  pointPhrases: string[];         // openers for stating P
  explainPhrases: string[];       // for E
  examplePhrases: string[];       // for the second E
  linkPhrases: string[];          // for L (return to question / final stance)
};
type SentenceStarter = { starter: string; example: string; whenToUse: string };
type Hedge = { phrase: string; meaning: string };
type TechniquesOutput = {
  peelOverview: string;
  peelByQuestionType: PeelBreakdown[];
  generalOpeners: SentenceStarter[];      // alternatives to "I think..."
  agreeStarters: SentenceStarter[];       // "Yes, I would..." variations
  disagreeStarters: SentenceStarter[];    // polite disagreement
  personalAnecdote: string[];             // bridges to lived experience
  hedgesAndQualifiers: Hedge[];           // "perhaps", "in my opinion", etc
  closingMoves: SentenceStarter[];        // wraps that link back to the question
  upgradedExamples: Array<{ weak: string; strong: string; technique: string; highlight: string }>;
};

async function loadRows(): Promise<Row[]> {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: { year: true, oralDays: true, oralModelAnswers: true },
  });
  return rows.map(r => ({
    year: r.year,
    oralDays: (r.oralDays as OralDay[]) ?? [],
    oralModelAnswers: (r.oralModelAnswers as OralModelAnswer[]) ?? [],
  }));
}

// Use richDescription when present, otherwise fall back to brief
// stimulusDescription. Note any rows missing both so the admin can
// run the enrichment button.
function effectiveDescription(d: OralDay): string {
  if (d.richDescription && d.richDescription.trim()) return d.richDescription.trim();
  return (d.stimulusDescription ?? "").trim();
}

async function deriveThemes(rows: Row[]): Promise<ThemesOutput> {
  try { return JSON.parse(await fs.readFile(THEMES_CACHE, "utf8")) as ThemesOutput; } catch { /* miss */ }

  const summary = rows.flatMap(r => r.oralDays.map(d => {
    const desc = effectiveDescription(d);
    const prompts = (d.conversationPrompts ?? []).map((q, i) => `    (${String.fromCharCode(97 + i)}) ${q}`).join("\n");
    return `=== ${r.year} • Day ${d.day} ===
PICTURE: ${desc || "(no description on file — run Enrich SBC for richer signal)"}
PROMPTS:
${prompts}`;
  })).join("\n\n");

  const missingRich = rows.flatMap(r => r.oralDays.filter(d => !d.richDescription).map(d => `${r.year}/D${d.day}`));
  if (missingRich.length > 0) {
    console.warn(`[themes] ${missingRich.length} day(s) without richDescription — using brief stimulusDescription as fallback: ${missingRich.join(", ")}`);
  }

  console.log("[themes] classifying SBC topics across all year × day combos...");
  const res = await withRetry("themes", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `The text below is the PSLE English Paper 4 Oral (Stimulus-Based Conversation, SBC) data for 2016-2025. Each year has TWO sets (Day 1 + Day 2). Each SBC picture is paired with 3 conversation prompts that an examiner asks the student.

${summary}

Classify EACH year × day into 1-2 TOPIC THEMES that capture what the conversation is actually about. The examiner is testing whether the student can give a thoughtful, well-structured opinion on a real-world Singapore-relevant issue. Examples of good theme labels (you may invent new ones too if needed):
- Healthy lifestyle / fitness
- Recycling / environmental responsibility
- Reading / lifelong learning
- Helping others / kindness
- Family bonding / neighbours
- Road safety / public conduct
- Hobbies / leisure activities
- School life / CCAs
- Food / hawker culture / nutrition
- Technology / screen time
- Community events / volunteering
- Future-oriented topics (AI, sustainability)
- Cultural events / festivals
- Time management / responsibility

Aim for 8-12 final themes. Group similar topics together.

Return strict JSON (NO markdown fences):
{
  "overview": "1 paragraph (≤180 words) summarising what the 10 years × 2 days collectively reveal — which SBC topics dominate, what's emerging, what's never been tested.",
  "prediction": "2-3 sentences predicting the MOST LIKELY SBC topic(s) for the next PSLE Oral exam. Cite year evidence (e.g. 'Recycling came up in 2018, 2022 — likely overdue'). Predict ONLY topics that have appeared.",
  "themes": [
    {
      "name": "Recycling / environmental responsibility",
      "description": "Doing your part for the environment via recycling, less waste, energy conservation",
      "yearsAppeared": [
        { "year": "2022", "day": 1, "note": "shoe recycling drive at community centre" },
        { "year": "2018", "day": 2, "note": "school recycling banner" }
      ],
      "frequency": 2
    }
  ]
}

Order themes by frequency DESC. Every year × day combo (2016-2025, 2 days each = 20 slots) must appear in AT LEAST one theme.` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as ThemesOutput;
  await fs.writeFile(THEMES_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[themes] done — ${parsed.themes.length} themes covering ${parsed.themes.reduce((s, t) => s + t.frequency, 0)} year×day slots`);
  return parsed;
}

async function deriveTechniques(rows: Row[]): Promise<TechniquesOutput> {
  try { return JSON.parse(await fs.readFile(TECHNIQUES_CACHE, "utf8")) as TechniquesOutput; } catch { /* miss */ }

  // Group all model answers across years for pattern mining.
  const allAnswers = rows.flatMap(r => r.oralModelAnswers.map(a => ({
    year: r.year, day: a.day, q: a.q, answer: a.answer,
    // Pair with the matching prompt for question-type context.
    prompt: r.oralDays.find(d => d.day === a.day)?.conversationPrompts?.[
      a.q === "a" ? 0 : a.q === "b" ? 1 : 2
    ] ?? "",
  })));

  const bundle = allAnswers.map(a =>
    `--- ${a.year} D${a.day} (${a.q}) ---\nPrompt: ${a.prompt}\nAnswer: ${a.answer}`
  ).join("\n\n");

  console.log("[techniques] mining PEEL structure + sentence starters from model answers...");
  const res = await withRetry("techniques", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `You are coaching a PSLE student on the English Oral Stimulus-Based Conversation (SBC). Below are ${allAnswers.length} model answers from past PSLE papers (2016-2025), each paired with its conversation prompt.

${bundle}

Your job: extract the patterns that make these model answers score well, in a form a student can MEMORISE and DEPLOY.

PEEL = Point, Explain/Elaborate, Example/Evidence, Link. The model answers nearly always follow this structure (often implicitly). Identify the linguistic moves used at each PEEL step.

ALSO — pay special attention to SENTENCE STARTERS. A common weakness is starting every sentence with "I think...". The model answers have much wider variation. Examples to mine: "Well,", "In my opinion,", "Personally,", "From my experience,", "Honestly speaking,", "Indeed,", "To be frank,", "What's more,", "On top of that,", "Apart from that,", "For instance,", "All in all,". Find ALL of them in the model answers.

Return strict JSON (NO markdown fences):
{
  "peelOverview": "2-3 sentence summary of how PSLE model answers use PEEL — including length norms (sentences per PEEL step), and the common rhythm.",
  "peelByQuestionType": [
    {
      "questionType": "Would you be interested in / would you participate in <activity>?",
      "pointPhrases": ["Yes, I would definitely be interested in ...", "Personally, I would jump at the chance to ...", "No, I would politely decline, mainly because ..."],
      "explainPhrases": ["The main reason is that ...", "This is because I believe ...", "What appeals to me most is ..."],
      "examplePhrases": ["For instance, ...", "Just last weekend, I ...", "A perfect example of this is ..."],
      "linkPhrases": ["For these reasons, I would ...", "All in all, this is an opportunity I would not miss.", "So yes, this is something I would love to take part in."]
    },
    {
      "questionType": "Have you ever experienced / done something similar?",
      "pointPhrases": ["Yes, I have had a similar experience ...", "Indeed, I remember a time when ..."],
      "explainPhrases": [...],
      "examplePhrases": [...],
      "linkPhrases": [...]
    },
    {
      "questionType": "Why is <topic> important?",
      "pointPhrases": [...],
      "explainPhrases": [...],
      "examplePhrases": [...],
      "linkPhrases": [...]
    },
    {
      "questionType": "Do you agree that / what do you think about <claim>?",
      "pointPhrases": [...],
      "explainPhrases": [...],
      "examplePhrases": [...],
      "linkPhrases": [...]
    }
  ],
  "generalOpeners": [
    { "starter": "Well,", "example": "Well, this is certainly a tricky question to answer.", "whenToUse": "Buys a beat to think; signals you're considering the question." },
    { "starter": "In my opinion,", "example": "In my opinion, recycling should start at home.", "whenToUse": "Signals a personal stance without being aggressive." },
    { "starter": "Personally,", "example": "Personally, I find this activity very meaningful.", "whenToUse": "Softens an opinion as your own view." },
    { "starter": "From my experience,", "example": "From my experience, group projects always teach me more.", "whenToUse": "Bridges into a real-life anecdote." },
    { "starter": "Honestly speaking,", "example": "Honestly speaking, I used to avoid such events.", "whenToUse": "Adds candour; good for showing growth or change of mind." }
  ],
  "agreeStarters": [
    { "starter": "Yes, I would definitely ...", "example": "Yes, I would definitely take part in this.", "whenToUse": "Strong, confident agreement." },
    { "starter": "Without a doubt, ...", "example": "Without a doubt, this is a worthy cause.", "whenToUse": "Even stronger; emphatic." },
    { "starter": "Indeed, ...", "example": "Indeed, every small action counts.", "whenToUse": "Formal agreement; good after the examiner makes a statement." }
  ],
  "disagreeStarters": [
    { "starter": "I would respectfully disagree because ...", "example": "I would respectfully disagree because the benefits are short-lived.", "whenToUse": "Polite disagreement; never just 'no'." },
    { "starter": "While I understand the appeal, ...", "example": "While I understand the appeal, I think there are downsides too.", "whenToUse": "Acknowledges the other side before objecting." }
  ],
  "personalAnecdote": [
    "Just last week, I ...",
    "A few months ago, my family and I ...",
    "I remember a time when ...",
    "In fact, my own grandmother used to ...",
    "This reminds me of an incident at my school ..."
  ],
  "hedgesAndQualifiers": [
    { "phrase": "perhaps", "meaning": "Softens a strong claim — 'perhaps the most important factor is ...'" },
    { "phrase": "to some extent", "meaning": "Partial agreement / nuance — 'I agree, to some extent.'" },
    { "phrase": "in most cases", "meaning": "Avoids absolute claims — 'in most cases, this works well.'" },
    { "phrase": "arguably", "meaning": "Frames a claim as defensible — 'arguably the best way to ...'" }
  ],
  "closingMoves": [
    { "starter": "All in all, ...", "example": "All in all, I would jump at the chance.", "whenToUse": "Standard PEEL Link — recaps and lands the stance." },
    { "starter": "For these reasons, ...", "example": "For these reasons, I think this is a valuable initiative.", "whenToUse": "Loops back to the original question after giving evidence." },
    { "starter": "So yes, ...", "example": "So yes, this is something I would love to be part of.", "whenToUse": "Conversational, confident close to a 'would you...?' answer." }
  ],
  "upgradedExamples": [
    {
      "weak": "I think this is good because it helps the environment.",
      "strong": "Personally, I see this as a step in the right direction — recycling our worn-out items keeps them out of landfills and gives them a second life.",
      "technique": "Replace 'I think' with 'Personally,' + add a vivid 'second life' image",
      "highlight": "Personally, I see this as a step in the right direction"
    }
  ]
}

For "upgradedExamples", give AT LEAST 8 — each should rewrite a generic P5-level oral answer fragment into a P6-distinction-level one. Highlight the key swap.` }] }],
    config: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 32768 },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as TechniquesOutput;
  await fs.writeFile(TECHNIQUES_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[techniques] done — ${parsed.peelByQuestionType.length} question types, ${parsed.upgradedExamples.length} sentence upgrades`);
  return parsed;
}

async function main() {
  const force = process.argv.includes("--force");
  if (force) {
    for (const f of [THEMES_CACHE, TECHNIQUES_CACHE]) {
      try { await fs.unlink(f); console.log(`[force] removed ${path.basename(f)}`); } catch { /* miss */ }
    }
  }
  const rows = await loadRows();
  if (rows.length === 0) {
    console.error("No EnglishSupplementaryPaper rows with status='ready' found.");
    process.exit(1);
  }
  console.log(`Loaded ${rows.length} papers (${rows.map(r => r.year).join(", ")})`);
  const enriched = rows.flatMap(r => r.oralDays).filter(d => d.richDescription).length;
  const total = rows.flatMap(r => r.oralDays).length;
  console.log(`SBC rich descriptions: ${enriched}/${total} (use admin "✨ Enrich SBC descriptions" to fill the rest)`);

  await deriveThemes(rows);
  await deriveTechniques(rows);
  console.log("\nDone. Run `npx tsx scripts/build-english-oral-docx.ts` next.");
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
