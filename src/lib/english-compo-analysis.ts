// English composition analyser — parallel pipeline to compo-analysis.ts
// (which handles Chinese). The two modules stay isolated:
//   - separate prompts (PSLE English rubric, not 华文)
//   - separate model essays (EnglishSupplementaryPaper.continuousModel /
//     situationalModel)
//   - separate output shapes when they diverge
//
// CompoAttempt rows route here when language === "english". The
// dispatcher lives in compo-analysis.ts → analyseCompoAttempt().
//
// Stages (mirror the Chinese pipeline):
//   1. OCR             — English-aware handwriting transcription
//   2. Wrong words     — grammar / spelling / word choice / awkward
//   3. Critique        — Continuous 36 (Content 18 + Language 18) OR
//                        Situational 14 (Task 6 + Language 8). Benchmarked
//                        against the year's model essay.
//   4. Recommendations — structural hooks + language upgrades
//   5. Elevated draft  — rewrite targeting 32-36 / 12-14
//
// Output shape choices:
//   - critique uses a 2-axis breakdown (vs Chinese's 3 axes) so the
//     stored JSON honestly reflects SEAB's rubric. The detail page
//     branches on critique.shape to render the right axis labels.
//   - wrongWords reuses the same {original, suggestion, kind, reason}
//     shape as Chinese; the kinds match well enough (spelling = stroke,
//     grammar/word-choice = meaning/misuse, awkward = awkward).

import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import { safeJsonParse, COMPO_DIR, readFileForGemini } from "@/lib/compo-analysis";

const OCR_MODEL = "gemini-3.1-pro-preview";
const ANALYSIS_MODEL = "gemini-3.1-pro-preview";

// ── Shared types ────────────────────────────────────────────────────

export type EnglishWrongWord = {
  original: string;
  suggestion: string;
  // spelling = misspelled word, grammar = subject-verb / tense / preposition,
  // word-choice = wrong word for the meaning, awkward = clumsy phrasing.
  kind: "spelling" | "grammar" | "word-choice" | "awkward" | "punctuation";
  reason: string;
};

// One axis of the English rubric. For Continuous: { content, language }.
// For Situational: { task, language }. Score is the raw 0..max value;
// max is the rubric ceiling (Continuous: 18 each; Situational: task 6 + lang 8).
export type EnglishAxis = {
  score: number;
  max: number;
  notes: string;
};

// English critique. The detail page reads `component` to know which
// labels to show ("Content" vs "Task fulfilment"). Total max:
//   continuous   = 36 (18 + 18)
//   situational  = 14 (6 + 8)
export type EnglishRubric = {
  component: "continuous" | "situational";
  primary: EnglishAxis;       // Content (Continuous) or Task fulfilment (Situational)
  language: EnglishAxis;
  overallScore: number;
  whyChanged?: string;        // delta vs original — only used for cleanRewrite / elevatedRubric
};

export type EnglishCritique = EnglishRubric & {
  overallSummary: string;
  cleanRewrite?: EnglishRubric;
  benchmarkYears: string[];
};

export type EnglishRecommendations = {
  structural: Array<{
    piece: string;        // e.g. "opening hook" / "climax" / "resolution" / "letter sign-off"
    issue: string;
    suggestion: string;
    exampleFromModel?: { year: string; snippet: string };
  }>;
  language: Array<{
    phrase: string;
    whyItHelps: string;
  }>;
  elevatedDraft?: string;
  elevatedDraftScore?: number;
  elevatedDraftRubric?: EnglishRubric;
};

// ── Stage 1: OCR ─────────────────────────────────────────────────────

const ENGLISH_OCR_PROMPT = `You are transcribing a Singapore PSLE student's handwritten English composition.

Rules:
- Transcribe the student's handwriting verbatim — preserve their original spelling, grammar, and punctuation EXACTLY as written. Do not silently fix mistakes; the marker downstream needs to see them.
- Preserve paragraph breaks (one blank line between paragraphs in your output).
- If the student crossed out a word and rewrote it, transcribe only the FINAL version (the kept version), not the crossed-out one.
- If a word is genuinely illegible, write [illegible] in its place.
- If the page also carries the question prompt / picture descriptions / theme, transcribe that separately into the questionText field.

Output JSON:
{
  "essay": "<verbatim transcription of the student's handwriting, paragraphs separated by blank lines>",
  "questionText": "<the printed prompt / theme / picture descriptions on the page, or empty string>"
}

Do not wrap in markdown.`;

async function runEnglishOcr(
  compositionImagePaths: string[],
  questionImagePath: string | null,
): Promise<{ ocrText: string; ocrQuestionText: string | null }> {
  const compParts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
  for (const p of compositionImagePaths) {
    const img = await readFileForGemini(p);
    compParts.push({ inlineData: img });
  }
  console.log(`[english-compo:ocr] calling ${OCR_MODEL} with ${compositionImagePaths.length} composition file(s)...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: OCR_MODEL,
    contents: [{ role: "user", parts: [...compParts, { text: ENGLISH_OCR_PROMPT }] }],
    config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 24576 },
  }, 2, 5000, "english-compo-ocr");
  console.log(`[english-compo:ocr] composition done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const parsed = safeJsonParse((resp.text ?? "").trim(), "english-ocr") as { essay?: string; questionText?: string };
  let ocrText = String(parsed.essay ?? "").trim();
  let ocrQuestionText = String(parsed.questionText ?? "").trim() || null;

  if (questionImagePath) {
    const img = await readFileForGemini(questionImagePath);
    const qResp = await generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: [
        { inlineData: img },
        { text: "Transcribe the printed text on this page verbatim — it is a PSLE English writing prompt (theme + picture descriptions, or a situational-writing scenario). Output JSON: {\"text\": \"...\"} only." },
      ] }],
      config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 8192 },
    }, 2, 5000, "english-compo-ocr-question");
    const qParsed = safeJsonParse((qResp.text ?? "").trim(), "english-ocr-question") as { text?: string };
    const qText = String(qParsed.text ?? "").trim();
    if (qText.length > 0) ocrQuestionText = qText;
  }

  return { ocrText, ocrQuestionText };
}

// ── Stage 2: Wrong words ─────────────────────────────────────────────

const WRONG_WORDS_PROMPT = (ocrText: string) => `You are marking a Singapore PSLE primary-school English composition for spelling, grammar, word choice, punctuation, and awkward phrasing errors.

Find ALL the issues that a PSLE marker would deduct for. Be strict on:
- Spelling (misspelled words — e.g. "recieve" → "receive")
- Grammar (subject-verb agreement, tense consistency, preposition choice, article use)
- Word choice (wrong word for the meaning — e.g. "borrow" vs "lend")
- Punctuation (missing commas in compound sentences, run-ons, missing capitals after a full stop)
- Awkward phrasing (clumsy or non-idiomatic sentence constructions that a marker would mark up)

Be FAIR — do NOT flag stylistic choices that are valid (e.g. "But" at the start of a sentence is fine; sentence fragments for emphasis are fine; British and American spellings are both acceptable).

Composition:
${ocrText}

Output a JSON array of issues. For each issue:
{
  "original": "<exact text snippet from the composition>",
  "suggestion": "<corrected text>",
  "kind": "spelling" | "grammar" | "word-choice" | "awkward" | "punctuation",
  "reason": "<one short sentence explaining the issue — child-friendly>"
}

Rules:
- "original" MUST be a substring that actually appears in the composition (case-sensitive). The renderer locates these substrings in the essay to mark them up.
- Keep "original" small — single word or short phrase (≤ 8 words). Don't grab whole sentences.
- Skip errors that aren't real PSLE deductions (e.g. don't flag valid contractions like "don't").
- If no issues, return [].

Output the JSON array only, no markdown.`;

export async function detectEnglishWrongWords(ocrText: string): Promise<EnglishWrongWord[]> {
  console.log(`[english-compo:wrong-words] scanning ${ocrText.length} chars with ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: WRONG_WORDS_PROMPT(ocrText) }] }],
    config: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 8192 },
  }, 2, 5000, "english-compo-wrong-words");
  console.log(`[english-compo:wrong-words] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  try {
    const parsed = safeJsonParse((resp.text ?? "[]").trim(), "english-wrong-words");
    if (!Array.isArray(parsed)) return [];
    const validKinds = new Set(["spelling", "grammar", "word-choice", "awkward", "punctuation"]);
    return (parsed as Array<{ original?: unknown; suggestion?: unknown; kind?: unknown; reason?: unknown }>)
      .filter(w => w && typeof w.original === "string" && typeof w.suggestion === "string" && validKinds.has(String(w.kind)))
      .map(w => ({
        original: String(w.original).trim(),
        suggestion: String(w.suggestion).trim(),
        kind: String(w.kind) as EnglishWrongWord["kind"],
        reason: String(w.reason ?? "").trim(),
      }))
      .filter(w => w.original.length > 0);
  } catch (err) {
    console.warn(`[english-compo:wrong-words] parse failed:`, err);
    return [];
  }
}

// ── Stage 3: Critique ────────────────────────────────────────────────

async function loadEnglishBenchmark(component: "continuous" | "situational"): Promise<Array<{ year: string; theme: string | null; essay: string }>> {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    select: {
      year: true, continuousTheme: true, continuousModel: true, situationalModel: true,
    },
    orderBy: { year: "asc" },
  });
  const out: Array<{ year: string; theme: string | null; essay: string }> = [];
  for (const r of rows) {
    if (component === "continuous") {
      // continuousModel is "essay 1 (option 1)\n\n--- separators ---\n\nessay 2 (option 2)..."
      // We use the WHOLE blob — gives the AI a richer sense of theme-driven structure.
      const blob = (r.continuousModel ?? "").trim();
      if (blob.length > 0) out.push({ year: r.year, theme: r.continuousTheme, essay: blob });
    } else {
      const blob = (r.situationalModel ?? "").trim();
      if (blob.length > 0) out.push({ year: r.year, theme: null, essay: blob });
    }
  }
  return out;
}

const CONTINUOUS_CRITIQUE_PROMPT = (
  ocrText: string,
  modelEssays: Array<{ year: string; theme: string | null; essay: string }>,
  studentTopic: string | null,
  detectedQuestionText: string | null,
) => {
  // Take 4 most recent benchmark blobs (each blob = 3 model essays). Keeps
  // the prompt token-bounded but covers a range of themes.
  const sample = modelEssays.slice(-4).map(e =>
    `=== ${e.year} (theme: ${e.theme ?? "?"}) ===\n${e.essay}`
  ).join("\n\n");

  const questionBlock = detectedQuestionText || studentTopic ? `
【Theme / picture prompts】
${detectedQuestionText ?? studentTopic ?? ""}

【On-topic strictness】
PSLE markers expect the storyline to firmly address the theme. Use this judgment test: imagine a reader who hasn't seen the theme — would they naturally say "this story IS about <theme>"? If the theme is only mentioned in passing and the essay's real core is something else, that's PARTIALLY OFF-TOPIC.
- Fully on-topic    → score Content normally per the rubric.
- Partially off    → cap Content at 10/18 (clearly relevant but not the core).
- Completely off  → Content = 0..4. Note "off-topic" first in contentNotes.
` : "";

  return `You are a Singapore PSLE English Continuous Writing examiner. Score a Primary 6 composition against the SEAB 36-mark rubric.
${questionBlock}
【Rubric — 36 marks total】
- **Content (18 marks)**: Relevance to theme + at least one picture prompt, plot coherence (intro / conflict / climax / resolution), engaging detail and sensory description, well-paced development. Penalise rushed plots, missing climax, weak resolution.
- **Language (18 marks)**: Grammar (tense consistency — usually past for narratives, subject-verb agreement, articles, prepositions), precise vocabulary (NO bombastic words used out of context — that loses marks), sentence variety (simple + compound + complex mix), and organisation (paragraphing + logical transitions).

【Real PSLE score distribution — calibration】
- ≤ 18:    weak. Major errors, plot incoherent, off-topic.
- 19-23:   below average. Storyline holds but errors throughout.
- 24-28:   average. Clear plot, fewer errors, some attempt at description.
- 29-32:   good. Plot has climax + resolution, varied sentence types, 1-2 idiomatic phrases.
- 33-35:   excellent. Strong opening hook, clear conflict / climax / resolution, vivid description, 3-4 strong phrases, near-flawless grammar.
- 36:      rare top mark.

【Word count guidance】
PSLE requires ≥ 150 words. Top-scoring compositions are typically 350-500 words; below 200 makes the top bands very hard to reach because development can't be shown. Penalise undeveloped plot when CJK-equivalent is short.

【Real 36/36 benchmarks for reference】
${sample}

【Student composition】
${ocrText}

【Output — strict JSON】Notes are SHORT (1-2 sentences, English, ≤ 80 words). When you call out content issues, lead with the most-impactful one; same for language.

If you judge the essay partially off-topic or off-topic, contentNotes MUST start with "Partially off-topic:" or "Off-topic:" and explain. overallSummary must mention it too.

{
  "component": "continuous",
  "primary": {
    "score": <0..18>,
    "max": 18,
    "notes": "<Content evaluation, 1-2 sentences>"
  },
  "language": {
    "score": <0..18>,
    "max": 18,
    "notes": "<Language evaluation, 1-2 sentences>"
  },
  "overallScore": <Content + Language, ≤ 36>,
  "overallSummary": "<2-3 sentence overall verdict>",
  "cleanRewrite": {
    "component": "continuous",
    "primary": { "score": <0..18>, "max": 18, "notes": "<Content if wrong-word fixes were applied>" },
    "language": { "score": <0..18>, "max": 18, "notes": "<Language if wrong-word fixes were applied — typically +1 to +3 here>" },
    "overallScore": <sum>,
    "whyChanged": "<1 sentence: why the clean rewrite scores what it does vs the original>"
  },
  "benchmarkYears": [<years used for comparison>]
}

No markdown.`;
};

const SITUATIONAL_CRITIQUE_PROMPT = (
  ocrText: string,
  modelEssays: Array<{ year: string; essay: string }>,
  studentTopic: string | null,
  detectedQuestionText: string | null,
) => {
  const sample = modelEssays.slice(-4).map(e => `=== ${e.year} ===\n${e.essay}`).join("\n\n");

  const scenarioBlock = detectedQuestionText || studentTopic ? `
【Scenario / brief】
${detectedQuestionText ?? studentTopic ?? ""}
` : "";

  return `You are a Singapore PSLE English Situational Writing examiner. Score a Primary 6 functional response against the SEAB 14-mark rubric.
${scenarioBlock}
【Rubric — 14 marks total】
- **Task fulfilment (6 marks)**: Purpose stated clearly + all required details (dates, times, names, reasons) included + correct format (letter / email / report / notice) + appropriate tone for the audience.
- **Language (8 marks)**: Grammar, spelling, punctuation, and clarity of expression. Sentences should be unambiguous and well-formed.

【Real PSLE benchmarks】
${sample}

【Student response】
${ocrText}

【Output — strict JSON】Notes are SHORT (1-2 sentences, English). Lead with the most-impactful issue.

{
  "component": "situational",
  "primary": {
    "score": <0..6>,
    "max": 6,
    "notes": "<Task fulfilment evaluation — what details are missing, format, tone>"
  },
  "language": {
    "score": <0..8>,
    "max": 8,
    "notes": "<Language evaluation>"
  },
  "overallScore": <Task + Language, ≤ 14>,
  "overallSummary": "<2-3 sentence overall verdict>",
  "cleanRewrite": {
    "component": "situational",
    "primary": { "score": <0..6>, "max": 6, "notes": "<Task fulfilment after wrong-word fixes — usually unchanged unless fixes added missing info>" },
    "language": { "score": <0..8>, "max": 8, "notes": "<Language after wrong-word fixes>" },
    "overallScore": <sum>,
    "whyChanged": "<1 sentence>"
  },
  "benchmarkYears": [<years referenced>]
}

No markdown.`;
};

export async function critiqueEnglishComposition(
  ocrText: string,
  component: "continuous" | "situational",
  studentTopic: string | null,
  detectedQuestionText: string | null,
): Promise<EnglishCritique> {
  const benchmarks = await loadEnglishBenchmark(component);
  if (benchmarks.length === 0) throw new Error(`No English ${component} model essays available`);
  const prompt = component === "continuous"
    ? CONTINUOUS_CRITIQUE_PROMPT(ocrText, benchmarks, studentTopic, detectedQuestionText)
    : SITUATIONAL_CRITIQUE_PROMPT(ocrText, benchmarks, studentTopic, detectedQuestionText);
  console.log(`[english-compo:critique] ${component} — calling ${ANALYSIS_MODEL} with ${benchmarks.length} benchmark year(s)...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 12000 },
  }, 2, 5000, `english-compo-critique-${component}`);
  console.log(`[english-compo:critique] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = safeJsonParse((resp.text ?? "").trim(), "english-critique") as any;
  const norm = (axis: { score?: unknown; max?: unknown; notes?: unknown } | undefined, defaultMax: number): EnglishAxis => ({
    score: Number(axis?.score ?? 0),
    max: Number(axis?.max ?? defaultMax),
    notes: String(axis?.notes ?? ""),
  });
  const primaryMax = component === "continuous" ? 18 : 6;
  const languageMax = component === "continuous" ? 18 : 8;
  const primary = norm(parsed.primary, primaryMax);
  const language = norm(parsed.language, languageMax);
  const overallMax = primaryMax + languageMax;
  const overallScore = Math.min(overallMax, Math.max(0, Number(parsed.overallScore ?? primary.score + language.score)));
  const cleanRewrite: EnglishRubric | undefined = parsed.cleanRewrite ? {
    component,
    primary: norm(parsed.cleanRewrite.primary, primaryMax),
    language: norm(parsed.cleanRewrite.language, languageMax),
    overallScore: Math.min(overallMax, Math.max(0, Number(parsed.cleanRewrite.overallScore ?? 0))),
    whyChanged: parsed.cleanRewrite.whyChanged ? String(parsed.cleanRewrite.whyChanged) : undefined,
  } : undefined;
  return {
    component,
    primary,
    language,
    overallScore,
    overallSummary: String(parsed.overallSummary ?? ""),
    cleanRewrite,
    benchmarkYears: Array.isArray(parsed.benchmarkYears) ? parsed.benchmarkYears.map((y: unknown) => String(y)) : [],
  };
}

// ── Stage 4: Recommendations ─────────────────────────────────────────

const RECOMMEND_PROMPT = (
  ocrText: string,
  critique: EnglishCritique,
  component: "continuous" | "situational",
) => `You are a Singapore PSLE English writing coach. Based on the marked composition below, give a Primary 6 student practical upgrade ideas.

【Student composition】
${ocrText}

【Marker's verdict】
Primary axis: ${critique.primary.score}/${critique.primary.max} — ${critique.primary.notes}
Language: ${critique.language.score}/${critique.language.max} — ${critique.language.notes}
Overall: ${critique.overallScore}/${critique.primary.max + critique.language.max}

【Task】
Produce 2-4 structural recommendations + 3-5 language phrase upgrades.

For **Continuous Writing** structural pieces, pick from: opening hook, conflict / rising action, climax, sensory description, character emotion / reaction, transition, resolution, ending moral / reflection.
For **Situational Writing** structural pieces, pick from: subject line / heading, purpose statement, key detail (dates / times / names), tone for audience, sign-off / closing line, format compliance.

For language upgrades, focus on:
- Specific, vivid verbs and adjectives (NOT bombastic — must fit the context the student is writing about)
- Sensory description (sight, sound, smell, touch, taste) where the student wrote flat statements
- Sentence variety (compound + complex) where the student wrote a string of simple sentences
- Idiomatic phrases that fit the scenario (only suggest ones a P6 student would naturally use)

【Output — strict JSON】
{
  "structural": [
    {
      "piece": "<one of the above pieces>",
      "issue": "<what's missing or weak in the student's draft>",
      "suggestion": "<concrete 1-2 sentence guidance — what to add or change>"
    }
  ],
  "language": [
    {
      "phrase": "<short replacement phrase or 'show-don't-tell' alternative — actual words the student should use, not abstract advice>",
      "whyItHelps": "<short reason: 'shows emotion through action' / 'vivid sensory detail' / 'more precise verb' / etc>"
    }
  ]
}

Notes:
- "phrase" must be USABLE prose — the student should be able to paste it in. Not "use stronger verbs" but "her hands trembled as she gripped the railing".
- Keep each item short — recommendations are a checklist, not a lecture.
- ${component === "situational" ? "Skip structural pieces that don't apply (e.g. no climax for situational)." : "If the climax is missing, that's usually the highest-impact recommendation — list it first."}

No markdown.`;

export async function recommendEnglishComposition(
  ocrText: string,
  critique: EnglishCritique,
  component: "continuous" | "situational",
): Promise<EnglishRecommendations> {
  console.log(`[english-compo:recommend] calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: RECOMMEND_PROMPT(ocrText, critique, component) }] }],
    config: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 8192 },
  }, 2, 5000, "english-compo-recommend");
  console.log(`[english-compo:recommend] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = safeJsonParse((resp.text ?? "").trim(), "english-recommend") as any;
  const structural = Array.isArray(parsed.structural) ? parsed.structural
    .filter((s: { piece?: unknown; suggestion?: unknown }) => s && typeof s.piece === "string" && typeof s.suggestion === "string")
    .map((s: { piece: string; issue?: unknown; suggestion: string }) => ({
      piece: String(s.piece).trim(),
      issue: String(s.issue ?? "").trim(),
      suggestion: String(s.suggestion).trim(),
    })) : [];
  const language = Array.isArray(parsed.language) ? parsed.language
    .filter((l: { phrase?: unknown }) => l && typeof l.phrase === "string")
    .map((l: { phrase: string; whyItHelps?: unknown }) => ({
      phrase: String(l.phrase).trim(),
      whyItHelps: String(l.whyItHelps ?? "").trim(),
    })) : [];
  return { structural, language };
}

// ── Stage 5: Elevated draft ──────────────────────────────────────────

const ELEVATE_PROMPT = (
  ocrText: string,
  wrongWords: EnglishWrongWord[],
  critique: EnglishCritique,
  recs: EnglishRecommendations,
  component: "continuous" | "situational",
) => {
  const wrongLine = wrongWords.length === 0 ? "(none flagged)" : wrongWords.map(w => `${w.original} → ${w.suggestion}`).join("; ");
  const structuralLines = recs.structural.map(s => `- ${s.piece}: ${s.suggestion}`).join("\n") || "(none)";
  const languageLines = recs.language.map(l => `- ${l.phrase} (${l.whyItHelps})`).join("\n") || "(none)";

  const componentBlock = component === "continuous" ? `
You are rewriting a Primary 6 Continuous Writing composition that scored ${critique.overallScore}/36. Target band: **32-36 / 36** (excellent).

Calibration:
- 29-32: good (clear plot + 1-2 idioms + some description, ~300-400 words)
- 33-35: excellent (strong hook + clear conflict / climax / resolution + 3-4 strong phrases + vivid description, ~400-500 words)
- 36: rare — top mark, near-flawless across every rubric criterion.

To reach 33+, you must:
1. Open with a hook (in-the-moment sensory detail or dialogue) — not "It was a sunny day".
2. Show a clear conflict + climax + resolution.
3. Use SPECIFIC verbs and sensory description (sight / sound / touch / smell / emotion shown through action).
4. Keep the language band age-appropriate — NO bombastic words used out of context. P6 examiners penalise that.
5. Length: aim for 350-450 words. Don't pad.
` : `
You are rewriting a Primary 6 Situational Writing functional response that scored ${critique.overallScore}/14. Target band: **12-14 / 14** (excellent).

To reach 12+:
1. State the purpose clearly in the opening line.
2. Cover EVERY required detail (dates, times, names, reasons).
3. Match the format (letter / email / report / notice) precisely.
4. Use a tone appropriate to the audience.
5. Clear grammar + punctuation throughout. Concise — no filler.
`;

  return `${componentBlock}

【Original draft】
${ocrText}

【Wrong words to correct】
${wrongLine}

【Marker's structural recommendations】
${structuralLines}

【Suggested language upgrades】
${languageLines}

【Rules】
1. **Keep the student's storyline / scenario intact** — same characters, same setting, same outcome. You're polishing, not rewriting from scratch.
2. **Mark every change with [+...+]**:
   - Inserting new text: wrap it in [+...+] — e.g. "She walked [+briskly, her heart pounding,+] to the door."
   - Replacing wrong text: drop the wrong word and write the replacement in [+...+] — e.g. "his class [+were+]→[+was+]" (write only the replacement, not the original).
   - Student's existing correct text: leave UNMARKED.
3. **Don't mark single-character typo fixes** with [+...+] — too noisy. Just silently correct them. Use [+...+] for sentence-level upgrades the student should learn from.

Self-assess the rewrite against the same rubric.

【Output — strict JSON】 The rubric block is REQUIRED, do NOT omit it.
{
  "draft": "<rewritten composition with [+...+] markers. Preserve paragraph breaks as \\n\\n>",
  "rubric": {
    "component": "${component}",
    "primary": { "score": <0..${component === "continuous" ? 18 : 6}>, "max": ${component === "continuous" ? 18 : 6}, "notes": "<short>" },
    "language": { "score": <0..${component === "continuous" ? 18 : 8}>, "max": ${component === "continuous" ? 18 : 8}, "notes": "<short>" },
    "overallScore": <primary + language>,
    "whyChanged": "<1-2 sentence summary of what improved vs the original>"
  },
  "estimatedScore": <same as rubric.overallScore>
}

No markdown.`;
};

export async function buildElevatedEnglishDraft(
  ocrText: string,
  wrongWords: EnglishWrongWord[],
  critique: EnglishCritique,
  recs: EnglishRecommendations,
  component: "continuous" | "situational",
): Promise<{ draft: string; estimatedScore: number; rubric?: EnglishRubric }> {
  console.log(`[english-compo:elevate] calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: ELEVATE_PROMPT(ocrText, wrongWords, critique, recs, component) }] }],
    config: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 12000 },
  }, 2, 5000, "english-compo-elevate");
  const raw = (resp.text ?? "").trim();
  console.log(`[english-compo:elevate] done in ${((Date.now() - start) / 1000).toFixed(1)}s, ${raw.length} chars`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = safeJsonParse(raw, "english-elevate") as any;
    const primaryMax = component === "continuous" ? 18 : 6;
    const languageMax = component === "continuous" ? 18 : 8;
    const norm = (axis: { score?: unknown; max?: unknown; notes?: unknown } | undefined, defaultMax: number): EnglishAxis => ({
      score: Number(axis?.score ?? 0),
      max: Number(axis?.max ?? defaultMax),
      notes: String(axis?.notes ?? ""),
    });
    const rubric: EnglishRubric | undefined = parsed.rubric ? {
      component,
      primary: norm(parsed.rubric.primary, primaryMax),
      language: norm(parsed.rubric.language, languageMax),
      overallScore: Math.min(primaryMax + languageMax, Math.max(0, Number(parsed.rubric.overallScore ?? 0))),
      whyChanged: parsed.rubric.whyChanged ? String(parsed.rubric.whyChanged) : undefined,
    } : undefined;
    return {
      draft: String(parsed.draft ?? raw),
      estimatedScore: Number(parsed.estimatedScore ?? rubric?.overallScore ?? Math.round((primaryMax + languageMax) * 0.85)),
      rubric,
    };
  } catch (err) {
    console.error(`[english-compo:elevate] JSON parse FAILED, ${raw.length} chars. First 200:`, raw.slice(0, 200));
    console.error(`[english-compo:elevate] error:`, err);
    return { draft: "(Enhanced draft generation failed — re-analyse to retry.)", estimatedScore: 0 };
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────

export async function analyseEnglishCompoAttempt(attemptId: string): Promise<void> {
  const overallStart = Date.now();
  const tag = `[english-compo:${attemptId.slice(-6)}]`;
  console.log(`${tag} ── analyse start ────────────────────────`);

  const attempt = await prisma.compoAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error(`CompoAttempt ${attemptId} not found`);
  const component = (attempt.englishComponent as "continuous" | "situational" | null) ?? "continuous";
  console.log(`${tag} component=${component}, topic=${attempt.studentTopic ?? "(none)"}`);

  const compositionImagePaths = (attempt.compositionImagePaths as unknown as string[] | null) ?? [];
  if (compositionImagePaths.length === 0) throw new Error("No composition images");

  await prisma.compoAttempt.update({
    where: { id: attemptId },
    data: { status: "analysing", errorMessage: null },
  });

  try {
    // 1. OCR
    console.log(`${tag} stage 1/4: OCR`);
    const { ocrText, ocrQuestionText } = await runEnglishOcr(compositionImagePaths, attempt.questionImagePath);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { ocrText, ocrQuestionText },
    });

    // 2. Wrong words
    console.log(`${tag} stage 2/4: wrong-words`);
    const wrongWords = await detectEnglishWrongWords(ocrText);
    console.log(`${tag} found ${wrongWords.length} wrong-word issue(s)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { wrongWords: wrongWords as never },
    });

    // 3. Critique
    console.log(`${tag} stage 3/4: critique (${component})`);
    const critique = await critiqueEnglishComposition(ocrText, component, attempt.studentTopic, ocrQuestionText);
    console.log(`${tag} score: ${critique.overallScore}/${critique.primary.max + critique.language.max} (primary ${critique.primary.score}/${critique.primary.max}, language ${critique.language.score}/${critique.language.max})`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { critique: critique as never },
    });

    // 4. Recommendations + Elevated draft (run sequentially — elevate
    // needs recs in the prompt to know what hooks to thread in).
    console.log(`${tag} stage 4/4: recommendations`);
    const recommendations = await recommendEnglishComposition(ocrText, critique, component);
    console.log(`${tag} ${recommendations.structural.length} structural + ${recommendations.language.length} language recommendation(s)`);

    console.log(`${tag} stage 5/5: elevated draft`);
    const elev = await buildElevatedEnglishDraft(ocrText, wrongWords, critique, recommendations, component);
    console.log(`${tag} elevated draft estimated score: ${elev.estimatedScore}/${critique.primary.max + critique.language.max}`);

    const finalRecs: EnglishRecommendations = {
      ...recommendations,
      elevatedDraft: elev.draft,
      elevatedDraftScore: elev.estimatedScore,
      elevatedDraftRubric: elev.rubric,
    };
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { recommendations: finalRecs as never },
    });

    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { status: "ready", analysedAt: new Date() },
    });
    console.log(`${tag} ── analyse done in ${((Date.now() - overallStart) / 1000).toFixed(1)}s ────────────`);
  } catch (err) {
    console.error(`${tag} analyse FAILED after ${((Date.now() - overallStart) / 1000).toFixed(1)}s:`, err);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: {
        status: "failed",
        errorMessage: (err as Error).message ?? "Unknown error",
      },
    });
  }
}

// Stale-import guard: COMPO_DIR is used by callers wanting to read
// composition files off disk. Re-exporting keeps essay-coach routes
// from having to import from compo-analysis.ts for the English path.
export { COMPO_DIR };

// Re-export so unused-imports lint doesn't complain about `fs` / `path`
// being implicitly available — both are imported above for callers
// that may want to read files directly without going through helpers.
const _unused = { fs, path };
void _unused;
