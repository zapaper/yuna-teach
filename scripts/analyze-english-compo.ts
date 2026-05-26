// PSLE English composition analysis (2016-2025).
//
// Inputs: EnglishSupplementaryPaper rows (situationalWriting, continuousTheme,
// continuousPrompts, situationalModel, continuousModel — already extracted by
// the admin pipeline).
//
// Outputs (cached, re-runnable):
//   - scripts/eng-compo-themes.json    — theme heatmap + next-year prediction
//   - scripts/eng-compo-phrases.json   — openings / descriptions / closings
//
// Then build-english-compo-docx.ts produces the final Word doc.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";

const MODEL = "gemini-3.1-pro-preview";
const SCRIPT_DIR = __dirname;
const THEMES_CACHE = path.join(SCRIPT_DIR, "eng-compo-themes.json");
const PHRASES_CACHE = path.join(SCRIPT_DIR, "eng-compo-phrases.json");
const SITUATIONAL_CACHE = path.join(SCRIPT_DIR, "eng-compo-situational.json");
const CONTINUOUS_CRAFT_CACHE = path.join(SCRIPT_DIR, "eng-compo-continuous-craft.json");

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

type SituationalWriting = {
  purpose?: string; audience?: string; wordCount?: string;
  requirements?: string[]; scenario?: string;
};
type ContinuousPrompt = { optionNum?: number; brief?: string };
type Row = {
  year: string;
  situationalWriting: SituationalWriting | null;
  continuousTheme: string | null;
  continuousPrompts: ContinuousPrompt[];
  situationalModel: string | null;
  continuousModel: string | null;
};

type SituationalTheme = {
  name: string;            // e.g. "Persuade / convince a peer"
  description: string;     // 1-line core idea
  yearsAppeared: Array<{ year: string; note: string }>;
  frequency: number;
};
type ContinuousTheme = {
  name: string;            // e.g. "Loss / something missing"
  description: string;
  yearsAppeared: Array<{ year: string; pickedTheme: string; note: string }>;
  frequency: number;
};
type ThemesOutput = {
  overview: string;
  prediction: string;            // 2-3 sentences citing year evidence
  situationalThemes: SituationalTheme[];
  continuousThemes: ContinuousTheme[];
};

type PhraseGroup = { name: string; phrases: string[] };
type SentenceExample = {
  weak: string;            // generic / flat version
  strong: string;          // upgraded version
  technique: string;       // 1-line technique label
  highlight: string;       // substring of `strong` to bold
};
type PhrasesOutput = {
  // Situational writing helpers
  situationalOpenings: PhraseGroup[];    // e.g. greeting, hook, statement of purpose
  situationalConnectors: PhraseGroup[];  // formal linkers per audience
  situationalClosings: PhraseGroup[];    // sign-offs, polite calls to action

  // Continuous writing helpers
  continuousOpenings: PhraseGroup[];     // weather, dialogue, action, reflection
  showDontTell: {                        // emotion buckets
    name: string;                        // bucket name e.g. "Fear / nervousness"
    phrases: string[];                   // body-language / sensory phrases
  }[];
  sensoryDescriptions: PhraseGroup[];    // sight / sound / smell / touch
  dialogueTags: string[];                // alternatives to "said"
  continuousClosings: PhraseGroup[];     // resolution / reflection / lesson learned
  sentenceVariety: SentenceExample[];    // weak → strong upgrades
};

async function loadRows(): Promise<Row[]> {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: {
      year: true, situationalWriting: true, continuousTheme: true,
      continuousPrompts: true, situationalModel: true, continuousModel: true,
    },
  });
  return rows.map(r => ({
    year: r.year,
    situationalWriting: r.situationalWriting as SituationalWriting | null,
    continuousTheme: r.continuousTheme,
    continuousPrompts: (r.continuousPrompts as ContinuousPrompt[]) ?? [],
    situationalModel: r.situationalModel,
    continuousModel: r.continuousModel,
  }));
}

// ───────────────────────────────────────────────────────────────
// Stage A — themes + prediction
// ───────────────────────────────────────────────────────────────
async function deriveThemes(rows: Row[]): Promise<ThemesOutput> {
  try { return JSON.parse(await fs.readFile(THEMES_CACHE, "utf8")) as ThemesOutput; } catch { /* miss */ }

  const summary = rows.map(r => {
    const sw = r.situationalWriting;
    const prompts = r.continuousPrompts.map(p => `  opt${p.optionNum}: ${p.brief}`).join("\n");
    return `=== ${r.year} ===
SITUATIONAL — purpose: ${sw?.purpose ?? "(n/a)"} | audience: ${sw?.audience ?? "(n/a)"}
  scenario: ${(sw?.scenario ?? "").slice(0, 200)}
  requirements: ${(sw?.requirements ?? []).join("; ")}
CONTINUOUS — theme: ${r.continuousTheme ?? "(n/a)"}
${prompts}`;
  }).join("\n\n");

  console.log("[themes] classifying situational + continuous themes (2016-2025)...");
  const res = await withRetry("themes", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `The text below is the PSLE English Paper 1 (Writing) data for 2016-2025. Two sections per year:
- SITUATIONAL — short formal-ish writing task (letter / email / announcement) with a defined purpose and audience.
- CONTINUOUS — picture-based narrative writing with an overarching THEME and 3 picture options.

${summary}

Classify into two parallel sets of themes that a P6 student preparing for PSLE would find useful:

1. SITUATIONAL THEMES — by COMMUNICATIVE PURPOSE. Examples: "Persuade a peer to join", "Inform an authority figure of an incident", "Ask for permission from a teacher / principal", "Encourage someone to participate", "Recount and reflect on a learning experience". 6-10 distinct themes. Group by the underlying communicative move, not by audience.

2. CONTINUOUS THEMES — by NARRATIVE THEME. Each year has exactly one theme (e.g. "a secret", "a celebration", "a long wait", "trying something new"). Group similar themes into 6-12 buckets, e.g.:
   - Loss / something missing  (covers "something that was lost")
   - Surprises and revelations (covers "a secret")
   - First-time experiences   (covers "trying something new")
   - Endurance / patience      (covers "a long wait")
   - Gratitude / appreciation  (covers "being thankful", "a special gift")
   - Promises and trust         (covers "a promise")
   - Teamwork                   (covers "teamwork")
   - Change                     (covers "a change for the better")
   - Celebration                (covers "a celebration")
   - Each bucket can hold multiple years.

Return strict JSON (NO markdown fences):
{
  "overview": "1-paragraph summary (≤180 words) of what the 10 years collectively reveal — which situational moves and narrative themes dominate, and what's missing or rare.",
  "prediction": "2-3 sentences predicting the most LIKELY situational purpose AND continuous theme for the NEXT year. Cite supporting year evidence (e.g. 'Persuasion came up in 2020, 2022, 2023 — overdue if it doesn't reappear'). Only predict themes that have actually appeared.",
  "situationalThemes": [
    {
      "name": "Persuade a peer to join / try something",
      "description": "Convince a same-age classmate to take part",
      "yearsAppeared": [
        { "year": "2020", "note": "join your team" },
        { "year": "2022", "note": "persuade her to join the event" },
        { "year": "2023", "note": "join your group" }
      ],
      "frequency": 3
    }
  ],
  "continuousThemes": [
    {
      "name": "Loss / something missing",
      "description": "Story centred on losing or recovering something/someone",
      "yearsAppeared": [
        { "year": "2020", "pickedTheme": "something that was lost", "note": "lost phone / missing cat" }
      ],
      "frequency": 1
    }
  ]
}

Order each themes array by frequency DESC. Every year in 2016-2025 must appear at least once in BOTH arrays (situational + continuous). Sub-themes within a year are OK (a single year can appear in 2 situational buckets if both fit).` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as ThemesOutput;
  await fs.writeFile(THEMES_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[themes] done — ${parsed.situationalThemes.length} situational, ${parsed.continuousThemes.length} continuous`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage B — phrase + sentence-variety mining
// ───────────────────────────────────────────────────────────────
async function minePhrases(rows: Row[]): Promise<PhrasesOutput> {
  try { return JSON.parse(await fs.readFile(PHRASES_CACHE, "utf8")) as PhrasesOutput; } catch { /* miss */ }

  const situationalEssays = rows
    .filter(r => r.situationalModel)
    .map(r => `--- ${r.year} situational ---\n${r.situationalModel}`)
    .join("\n\n");
  const continuousEssays = rows
    .filter(r => r.continuousModel)
    .map(r => `--- ${r.year} continuous ---\n${r.continuousModel}`)
    .join("\n\n");

  console.log("[phrases] mining openings / show-don't-tell / closings / sentence variety...");
  const res = await withRetry("phrases", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `You are a PSLE English writing coach. Below are 10 years of PSLE English Paper 1 model essays (situational + continuous). Mine USABLE high-quality phrases that a P6 student can recycle to lift their writing.

=== SITUATIONAL MODELS ===
${situationalEssays}

=== CONTINUOUS MODELS ===
${continuousEssays}

Aggregate across all essays — DO NOT limit to one year. Each phrase group should have AT LEAST 5 phrases (more is better). Prefer phrases with strong imagery, sensory detail, body language, or polite formality.

Return strict JSON (NO markdown fences):
{
  "situationalOpenings": [
    { "name": "Friendly greeting + reason for writing", "phrases": ["I hope this letter finds you well.", "I am writing to tell you about ..."] },
    { "name": "Persuasive hook", "phrases": ["You wouldn't want to miss ...", "Imagine being able to ..."] },
    { "name": "Polite request to authority", "phrases": ["I would like to seek your permission to ...", "May I respectfully request ..."] }
  ],
  "situationalConnectors": [
    { "name": "Adding a reason", "phrases": ["This is because ...", "The main reason is that ...", "Furthermore, ..."] },
    { "name": "Giving examples", "phrases": ["For instance, ...", "To illustrate, ..."] },
    { "name": "Acknowledging objections", "phrases": ["I understand that ...", "Although ..., I believe ..."] }
  ],
  "situationalClosings": [
    { "name": "Polite call to action", "phrases": ["I hope you will consider ...", "I look forward to your reply."] },
    { "name": "Warm sign-off", "phrases": ["Thank you for your time.", "Yours sincerely,"] }
  ],
  "continuousOpenings": [
    { "name": "Weather / atmosphere", "phrases": ["The sun was beating down mercilessly ...", "A thick blanket of clouds hung over the city ..."] },
    { "name": "In-the-moment action", "phrases": ["My heart pounded as I ...", "I clutched the railing tightly ..."] },
    { "name": "Dialogue opener", "phrases": ["'Are you sure about this?' my friend asked nervously.", "'Hurry up!' Mum called from the kitchen."] },
    { "name": "Reflective flashback", "phrases": ["I still remember that fateful afternoon ...", "It was a day I would never forget ..."] }
  ],
  "showDontTell": [
    { "name": "Fear / nervousness", "phrases": ["My palms were clammy and my heart hammered against my ribs.", "I could feel my knees trembling as I ..."] },
    { "name": "Anger / frustration", "phrases": ["My fists clenched and my jaw tightened.", "Hot tears of fury stung my eyes."] },
    { "name": "Sadness / regret", "phrases": ["A heavy lump formed in my throat.", "Tears welled up uncontrollably."] },
    { "name": "Joy / excitement", "phrases": ["My face broke into the widest grin.", "I could barely contain my excitement."] },
    { "name": "Surprise / shock", "phrases": ["My jaw dropped in disbelief.", "I froze mid-step, unable to process what I had just seen."] },
    { "name": "Embarrassment / shame", "phrases": ["My cheeks burned crimson.", "I wished the ground would swallow me whole."] },
    { "name": "Relief", "phrases": ["A wave of relief washed over me.", "I exhaled the breath I had been holding."] }
  ],
  "sensoryDescriptions": [
    { "name": "Sight", "phrases": ["a glistening pool of ...", "shafts of golden light filtered through ..."] },
    { "name": "Sound", "phrases": ["the rhythmic patter of raindrops ...", "a deafening silence engulfed the room ..."] },
    { "name": "Smell / taste", "phrases": ["the rich aroma of freshly baked bread wafted out ...", "the salty tang of the sea air ..."] },
    { "name": "Touch / texture", "phrases": ["the rough bark scraped against my palm ...", "a chill ran down my spine ..."] }
  ],
  "dialogueTags": ["whispered hoarsely", "stammered nervously", "muttered under my breath", "exclaimed in delight", "interjected sharply", "mused thoughtfully", "snapped impatiently"],
  "continuousClosings": [
    { "name": "Reflection / lesson learned", "phrases": ["From that day onwards, I understood the importance of ...", "It was a lesson I would carry with me forever."] },
    { "name": "Resolution / change", "phrases": ["I knew I would never make the same mistake again.", "From that moment on, things would be different."] },
    { "name": "Vivid final image", "phrases": ["As the sun dipped below the horizon, I knew ...", "A warm, contented smile spread across my face."] }
  ],
  "sentenceVariety": [
    {
      "weak": "I was very scared when I saw the dog.",
      "strong": "The moment I locked eyes with the snarling dog, my blood ran cold.",
      "technique": "Lead with the moment + sensory consequence (instead of 'I was X')",
      "highlight": "The moment I locked eyes"
    },
    {
      "weak": "I went into the room and I saw the broken vase.",
      "strong": "As I tiptoed into the room, my gaze fell upon the shattered vase.",
      "technique": "Subordinate clause + stronger verbs",
      "highlight": "As I tiptoed into the room"
    },
    {
      "weak": "It was a hot day.",
      "strong": "The midday sun glared down on us, baking the pavement until it shimmered.",
      "technique": "Personify + add a consequence",
      "highlight": "glared down on us"
    }
  ]
}

Give AT LEAST 8 entries for sentenceVariety — each must rewrite a generic P5-level sentence into a P6-distinction-level one, with the rewrite technique named.` }] }],
    config: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 32768 },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as PhrasesOutput;
  await fs.writeFile(PHRASES_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[phrases] done — ${parsed.showDontTell.length} emotions, ${parsed.sentenceVariety.length} sentence rewrites`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage C — situational writing: structure + reason-paragraph craft
// ───────────────────────────────────────────────────────────────
type SituationalParagraph = {
  paragraphLabel: string;          // e.g. "Greeting + statement of purpose"
  whatItDoes: string;              // 1-line job of this paragraph
  sampleOpeners: string[];         // 3-5 phrases for this paragraph
};
type ReasonMove = {
  move: string;                    // e.g. "Hook with a vivid before/after image"
  why: string;
  examples: string[];              // 2-3 quotes from model essays
};
type SituationalCraft = {
  typicalStructure: SituationalParagraph[];
  keyInfoChecklist: string[];       // "address the audience by name", etc.
  reasonParagraphOverview: string;
  reasonParagraphMoves: ReasonMove[];
  reasonParagraphPhrases: PhraseGroup[];
};

async function analyzeSituational(rows: Row[]): Promise<SituationalCraft> {
  try { return JSON.parse(await fs.readFile(SITUATIONAL_CACHE, "utf8")) as SituationalCraft; } catch { /* miss */ }

  // Pair each model essay with its prompt so Gemini sees how each
  // requirement maps to a paragraph in the response.
  const bundle = rows.filter(r => r.situationalModel).map(r => {
    const sw = r.situationalWriting;
    return `=== ${r.year} ===
PURPOSE: ${sw?.purpose ?? "(n/a)"}
AUDIENCE: ${sw?.audience ?? "(n/a)"}
WORD COUNT: ${sw?.wordCount ?? "(n/a)"}
REQUIRED FACTS / POINTS TO ADDRESS:
${(sw?.requirements ?? []).map((r2, i) => `  ${i + 1}. ${r2}`).join("\n")}
SCENARIO: ${sw?.scenario ?? "(n/a)"}

MODEL ESSAY:
${r.situationalModel}`;
  }).join("\n\n");

  console.log("[situational] analysing structure + reason-paragraph craft...");
  const res = await withRetry("situational", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `You are a PSLE English writing coach. Below are 10 years of PSLE situational-writing prompts + the marker-approved model essays. Each prompt comes with the audience, purpose, and a list of FACTS the student MUST include.

${bundle}

The point of situational writing is to (a) cover all the required facts and (b) make the writing genuinely persuasive / informative — not just a checklist of facts. Look at HOW the model essays achieve (b) — especially the "reason" paragraph that explains WHY the audience should care, agree, allow, etc.

Return strict JSON (NO markdown fences):
{
  "typicalStructure": [
    {
      "paragraphLabel": "1. Greeting + statement of purpose",
      "whatItDoes": "Address the recipient and state in 1 sentence why you're writing.",
      "sampleOpeners": ["Dear Mr Tan, I hope this email finds you well.", "Dear Mrs Lim, I am writing to ask for your permission to ..."]
    },
    {
      "paragraphLabel": "2. The required facts (audience info, what / when / where)",
      "whatItDoes": "Deliver the must-include facts crisply and clearly.",
      "sampleOpeners": ["The event will be held on ...", "I would like to invite you to ..."]
    },
    {
      "paragraphLabel": "3. The 'reason' paragraph — WHY the audience should agree / care",
      "whatItDoes": "This is where the writing earns its marks — go beyond facts to give compelling reasons.",
      "sampleOpeners": ["..."]
    },
    {
      "paragraphLabel": "4. Polite call to action + sign-off",
      "whatItDoes": "Ask politely for what you want, thank them, sign off appropriately.",
      "sampleOpeners": ["..."]
    }
  ],
  "keyInfoChecklist": [
    "Address the audience by name with appropriate formality (Dear Mr/Mrs vs Hi)",
    "State your purpose in the opening line — don't bury it",
    "Cover EVERY required fact from the prompt (typically 3 — what / when / where, or who / why / how)",
    "Match register to audience (formal for principal/teacher, friendly for peer)",
    "Stay within the word count (usually 100-150 words)",
    "End with a polite call to action AND a sign-off"
  ],
  "reasonParagraphOverview": "2-3 sentences on why the 'reason' paragraph matters most in PSLE situational writing, and what separates a 4-mark answer from a 6-mark one.",
  "reasonParagraphMoves": [
    {
      "move": "Show the benefit to the audience, not just to yourself",
      "why": "Persuasion lands when the AUDIENCE sees what's in it for them.",
      "examples": ["From 2022: '...you would be joining a cause that helps ...'", "From 2020: '...we'd really appreciate your strength on the team because ...'"]
    },
    {
      "move": "Acknowledge the audience's possible hesitation",
      "why": "Pre-empting objections shows maturity and earns persuasion marks.",
      "examples": ["..."]
    },
    {
      "move": "Use a vivid mini-example to make the reason concrete",
      "why": "Specific > abstract. A small story humanises the ask.",
      "examples": ["..."]
    },
    {
      "move": "End the paragraph with the emotional payoff",
      "why": "Leave the reader feeling something before the call to action.",
      "examples": ["..."]
    }
  ],
  "reasonParagraphPhrases": [
    {
      "name": "Open the reason paragraph",
      "phrases": ["I am writing to ask you because ...", "The main reason I'm asking is that ...", "What makes this special is that ..."]
    },
    {
      "name": "Acknowledge / pre-empt objections",
      "phrases": ["I understand you might be worried that ...", "I know this might seem like a big ask, however ...", "Although ..., I assure you that ..."]
    },
    {
      "name": "Show benefit / 'what's in it for them'",
      "phrases": ["This would mean a lot to ...", "Your support would directly help ...", "You would be giving ... a chance to ..."]
    },
    {
      "name": "Land the emotional payoff",
      "phrases": ["I genuinely believe ...", "It would mean the world to ...", "I cannot think of anyone better suited than ..."]
    }
  ]
}

Pull real evidence from the model essays for the "examples" arrays — short quotes (15-25 words), each tagged with the source year. Cover at least 4 typical-structure paragraphs and 4-6 reason-paragraph moves.` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 16384 },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as SituationalCraft;
  await fs.writeFile(SITUATIONAL_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[situational] done — ${parsed.typicalStructure.length} structural paragraphs, ${parsed.reasonParagraphMoves.length} reason moves`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage D — continuous writing: structural patterns + craft tips
// ───────────────────────────────────────────────────────────────
type StructuralPattern = {
  pattern: string;                 // "Conclusion restates the title/theme"
  frequency: string;               // "9/10 essays"
  description: string;
  examples: Array<{ year: string; quote: string }>;
};
type CraftTip = { tip: string; example: string };
type CraftCategory = { category: string; tips: CraftTip[] };
type ContinuousCraft = {
  structuralPatterns: StructuralPattern[];
  craftCategories: CraftCategory[];
};

async function analyzeContinuousCraft(rows: Row[]): Promise<ContinuousCraft> {
  try { return JSON.parse(await fs.readFile(CONTINUOUS_CRAFT_CACHE, "utf8")) as ContinuousCraft; } catch { /* miss */ }

  const bundle = rows.filter(r => r.continuousModel).map(r =>
    `=== ${r.year} — theme: "${r.continuousTheme}" ===\n${r.continuousModel}`
  ).join("\n\n");

  console.log("[continuous-craft] analysing structural patterns + craft tips...");
  const res = await withRetry("continuous-craft", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `You are a PSLE English writing coach. Below are the marker-approved model essays for the PSLE Continuous Writing section (picture-based narrative) for 2016-2025. The themes change each year, but the CRAFT of writing a high-scoring narrative is consistent.

${bundle}

P6 students tend to focus on plot / content and neglect craft. Your job:

PART A — STRUCTURAL PATTERNS that appear consistently across model essays (e.g. "the conclusion restates or echoes the title/theme", "the opening uses a flash-forward or in-the-moment hook", "the climax is in paragraph 4 of 5"). For each pattern report frequency (X/10), description, and 2-3 actual quotes from real model essays (tag the year).

PART B — CRAFT TIPS grouped by category, each tip with a real before/after-style example. Categories:
1. "Making sentences more interesting" — varied sentence openers, beats of action / dialogue / inner thought, avoiding "I + verb + object" repetition
2. "Flow & transitions between paragraphs" — how the model essays move between scenes without jarring jumps
3. "Showing emotion through body language" — the model essays rarely just say 'I was nervous'; they show it
4. "Pacing — when to slow down and when to speed up" — how a climax slows down, how time-skips speed things up
5. "Vivid setting / atmosphere" — using weather/light/sound to set mood
6. "Conclusion craft" — how to land the ending so it feels resolved, not abrupt

Return strict JSON (NO markdown fences):
{
  "structuralPatterns": [
    {
      "pattern": "Conclusion echoes / restates the title or theme",
      "frequency": "9/10 essays",
      "description": "The final 1-2 sentences loop back to the year's theme word(s), giving the essay a satisfying ring of completion.",
      "examples": [
        { "year": "2020", "quote": "It was a day I would forever remember as the day I rediscovered what I had lost." },
        { "year": "2024", "quote": "From that day onwards, I learnt that trying something new can lead to the most rewarding experiences." }
      ]
    },
    {
      "pattern": "Opening uses an in-the-moment sensory hook",
      "frequency": "...",
      "description": "...",
      "examples": [...]
    },
    {
      "pattern": "Five-paragraph arc: setup → rising tension → climax → falling action → resolution",
      "frequency": "...",
      "description": "...",
      "examples": [...]
    },
    {
      "pattern": "Climax is centered on dialogue or sudden realisation",
      "frequency": "...",
      "description": "...",
      "examples": [...]
    },
    {
      "pattern": "Lesson / reflection appears in the final paragraph (the takeaway)",
      "frequency": "...",
      "description": "...",
      "examples": [...]
    }
  ],
  "craftCategories": [
    {
      "category": "Making sentences more interesting (varied openers)",
      "tips": [
        { "tip": "Start sentences with a participial phrase, an adverb, or a subordinate clause — don't start every sentence with 'I'.", "example": "Boring: 'I walked to the door.' Better: 'Heart pounding, I walked to the door.'" },
        { "tip": "Break up long stretches of narrative with a short, punchy sentence for emphasis.", "example": "Boring: 'I looked at the prize. I was very excited.' Better: 'I stared at the prize. My heart skipped. This was real.'" }
      ]
    },
    {
      "category": "Flow & transitions between paragraphs",
      "tips": [...]
    },
    {
      "category": "Showing emotion through body language",
      "tips": [...]
    },
    {
      "category": "Pacing — when to slow down and when to speed up",
      "tips": [...]
    },
    {
      "category": "Vivid setting / atmosphere",
      "tips": [...]
    },
    {
      "category": "Conclusion craft",
      "tips": [...]
    }
  ]
}

Aim for AT LEAST 4-5 structural patterns and 2-3 tips per craft category. Each tip's "example" should be a clear before → better contrast OR a short quote from a model essay.` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 32768 },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as ContinuousCraft;
  await fs.writeFile(CONTINUOUS_CRAFT_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[continuous-craft] done — ${parsed.structuralPatterns.length} patterns, ${parsed.craftCategories.length} craft categories`);
  return parsed;
}

async function main() {
  const force = process.argv.includes("--force");
  if (force) {
    for (const f of [THEMES_CACHE, PHRASES_CACHE, SITUATIONAL_CACHE, CONTINUOUS_CRAFT_CACHE]) {
      try { await fs.unlink(f); console.log(`[force] removed ${path.basename(f)}`); } catch { /* miss */ }
    }
  }
  const rows = await loadRows();
  if (rows.length === 0) {
    console.error("No EnglishSupplementaryPaper rows with status='ready' found.");
    process.exit(1);
  }
  console.log(`Loaded ${rows.length} papers (${rows.map(r => r.year).join(", ")})`);

  await deriveThemes(rows);
  await minePhrases(rows);
  await analyzeSituational(rows);
  await analyzeContinuousCraft(rows);
  console.log("\nDone. Run `npx tsx scripts/build-english-compo-docx.ts` next.");
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
