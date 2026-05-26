// Extraction pipeline for PSLE English Paper 1 (Writing), Paper 3
// (Listening Comprehension MCQs), and Paper 4 (Oral). Mirrors the
// Chinese pipeline in src/lib/chinese-supplementary.ts but uses
// English-specific prompts and reflects the different paper
// structure (Section A Situational + Section B Continuous Writing,
// listening MCQs, oral reading + stimulus).

import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { renderPdfToJpegs, renderPdfPage } from "./pdf-server";

const SECTION_MODEL = "gemini-3.1-pro-preview";
const OCR_MODEL = "gemini-3.1-pro-preview";

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}

async function withGeminiRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (![504, 503, 429, 500].includes(status as number) || i === attempts) break;
      const wait = 5000 * i;
      console.warn(`[english-supplementary] ${label} ${status} attempt ${i}/${attempts}, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function renderSinglePage(pdfBuffer: Buffer, pageNumber: number, maxDim = 1600, quality = 85): Promise<Buffer> {
  // Use the dedicated single-page renderer in pdf-server.ts. Much
  // faster than rendering the whole PDF and slicing one page —
  // matters a lot for the cropper UI, which fetches the page image
  // on demand and was taking 10-30s per click before.
  return renderPdfPage(pdfBuffer, pageNumber, maxDim, quality);
}

export async function cropPageImage(
  pageJpeg: Buffer,
  fractions: { left: number; top: number; width: number; height: number },
  outQuality = 90,
  rotateDegrees = 0,
): Promise<Buffer> {
  const meta = await sharp(pageJpeg).metadata();
  const W = meta.width ?? 0; const H = meta.height ?? 0;
  if (!W || !H) throw new Error("could not read source image dimensions");
  const left = Math.max(0, Math.round(fractions.left * W));
  const top = Math.max(0, Math.round(fractions.top * H));
  const width = Math.min(W - left, Math.round(fractions.width * W));
  const height = Math.min(H - top, Math.round(fractions.height * H));
  if (width <= 0 || height <= 0) throw new Error("crop dimensions are zero");
  let pipe = sharp(pageJpeg).extract({ left, top, width, height });
  if (rotateDegrees !== 0) pipe = pipe.rotate(rotateDegrees);
  return pipe.jpeg({ quality: outQuality, chromaSubsampling: "4:4:4" }).toBuffer();
}

// Identify each numbered MCQ question block on a listening page.
// Returns the page-relative bounding box (fractions 0-1) per
// question, plus its question number. The "block" includes the
// question stem AND its 3 picture options so the admin can read
// the whole thing as one image without us having to OCR / describe
// each option icon. Returns empty array on detection failure —
// no fallback because the page may genuinely have no MCQs.
export async function detectListeningQuestionsOnPage(
  pageJpeg: Buffer,
): Promise<Array<{ num: number; left: number; top: number; width: number; height: number }>> {
  try {
    const res = await withGeminiRetry("detect-listening-qs", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: `This is one page from a PSLE English Paper 3 (Listening Comprehension) booklet. Find every numbered MCQ question on the page.

For each question, return the bounding box of the WHOLE question block — the question number / stem PLUS the 3 picture options below or beside it (option labels are usually (1) (2) (3)). Don't crop the options off.

Box coordinates are fractions of the page (0 = top/left edge, 1 = bottom/right edge).

Strict JSON only, no markdown:
{ "questions": [ { "num": 1, "left": 0.05, "top": 0.10, "width": 0.9, "height": 0.18 }, ... ] }

If the page has no MCQs (cover, transcripts, blank), return: { "questions": [] }.` },
          { inlineData: { mimeType: "image/jpeg", data: pageJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "{}") as { questions?: Array<{ num: number; left: number; top: number; width: number; height: number }> };
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions
      .filter(q => typeof q.num === "number" && typeof q.left === "number" && typeof q.top === "number" && typeof q.width === "number" && typeof q.height === "number")
      .filter(q => q.width >= 0.05 && q.height >= 0.05);
  } catch (err) {
    console.warn(`[english-supplementary] detectListeningQuestionsOnPage failed:`, err);
    return [];
  }
}

// Ask Gemini to identify the bounding box of the main picture /
// illustration / photograph on a page. Returns fractions 0-1
// (top-left + size) that can be fed straight to cropPageImage.
// Adds 3% padding around the detected box so borders aren't cut
// off. Fall back to the whole page on parse failure.
// Centred 90% × 90% box — used when Gemini returns a degenerate
// or missing bounding box. Better than a 1×1 full-page crop because
// it strips PDF margins / headers / footers without losing the picture.
const FALLBACK_BOUNDS = { left: 0.05, top: 0.05, width: 0.9, height: 0.9 };

export async function detectPictureBounds(
  pageJpeg: Buffer,
  hint: string = "the main illustration / photograph",
): Promise<{ left: number; top: number; width: number; height: number }> {
  const res = await withGeminiRetry("detect-picture-bounds", () => ai().models.generateContent({
    model: SECTION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: `Look at this page image and find ${hint}. Return its bounding box as fractions of the page (0 = top/left edge, 1 = bottom/right edge).

Strict JSON only, no markdown:
{ "left": <0-1>, "top": <0-1>, "width": <0-1>, "height": <0-1> }

If no obvious picture is present, return the full page: { "left": 0, "top": 0, "width": 1, "height": 1 }.` },
        { inlineData: { mimeType: "image/jpeg", data: pageJpeg.toString("base64") } },
      ],
    }],
    config: { temperature: 0, responseMimeType: "application/json" },
  }));
  try {
    const parsed = JSON.parse(res.text ?? "") as { left?: number; top?: number; width?: number; height?: number };
    let left = Math.max(0, Math.min(1, parsed.left ?? 0));
    let top = Math.max(0, Math.min(1, parsed.top ?? 0));
    let width = Math.max(0, Math.min(1, parsed.width ?? 1));
    let height = Math.max(0, Math.min(1, parsed.height ?? 1));
    // Reject degenerate / near-degenerate boxes — Gemini sometimes
    // returns {0,0,0,0} or width<0.05 which fails sharp.extract.
    if (width < 0.05 || height < 0.05) {
      console.warn(`[detect-picture-bounds] degenerate box {l=${left}, t=${top}, w=${width}, h=${height}} — using 90% centred fallback`);
      return FALLBACK_BOUNDS;
    }
    // Pad 3% around the detected box.
    const padX = 0.03; const padY = 0.03;
    left = Math.max(0, left - padX);
    top = Math.max(0, top - padY);
    width = Math.min(1 - left, width + 2 * padX);
    height = Math.min(1 - top, height + 2 * padY);
    return { left, top, width, height };
  } catch {
    return FALLBACK_BOUNDS;
  }
}

// ── Types ──
export type SectionPages = {
  paper1Pages: number[];
  paper3Pages: number[];
  paper4Pages: number[];
  paper1AnswerPages: number[];
  paper3AnswerPages: number[];
  paper4AnswerPages: number[];
};

export type SituationalWriting = {
  picturePageNum: number | null;   // PSLE situational tasks usually have a stimulus picture above the task
  scenario: string;
  audience: string;
  purpose: string;
  requirements: string[];
  wordCount: string;
};
export type ContinuousPrompt = {
  optionNum: number;            // 1..3
  picturePageNum: number | null;
  brief: string;
};
export type ListeningMcqOption = { label: string; text: string };
export type ListeningMcq = {
  num: number;
  text: string;
  options: ListeningMcqOption[];
  isImageOptions: boolean;
  textNum: number | null;       // which Text 1-7 this question is tagged to
};
export type ListeningText = {
  textNum: number;              // 1..7
  content: string;              // the passage / dialogue / monologue read aloud
  questionNumbers: number[];    // which Q numbers reference this text
};
export type OralDay = {
  day: 1 | 2;
  readingPassage: string;
  stimulusPicturePageNum: number | null;
  stimulusDescription: string;
  conversationPrompts: string[];
};
export type OralModelAnswer = {
  day: 1 | 2;
  q: string;                     // "a" | "b" | "c"
  answer: string;
};
export type ListeningAnswer = { num: number; answer: string };
export type StructuredExtraction = {
  situationalWriting: SituationalWriting | null;
  continuousTheme: string | null;
  continuousPrompts: ContinuousPrompt[];
  listeningMcqs: ListeningMcq[];
  listeningTexts: ListeningText[];
  oralDays: OralDay[];
  situationalModel: string | null;
  continuousModel: string | null;
  listeningAnswers: ListeningAnswer[];
  oralModelAnswers: OralModelAnswer[];
};
export type SupplementaryExtraction = SectionPages & {
  pageCount: number;
  paper1Text: string;
  paper3Text: string;
  paper4Text: string;
  paper1AnswerText: string;
  paper3AnswerText: string;
  paper4AnswerText: string;
  structured: StructuredExtraction;
};

function pagesToInline(pages: Buffer[], indices: number[]) {
  return indices
    .filter(p => p >= 1 && p <= pages.length)
    .map(p => ({ inlineData: { mimeType: "image/jpeg", data: pages[p - 1].toString("base64") } }));
}

// ── Section detection ──
async function detectSections(pages: Buffer[]): Promise<SectionPages> {
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `The following images are all pages of a Singapore PSLE (Primary 6) English exam PDF, in page order (page 1 first, total ${pages.length} pages).

For each page, decide which section it belongs to:
- "paper1"        → Paper 1: Writing (Section A Situational Writing + Section B Continuous Writing with picture prompts)
- "paper2"        → Paper 2: Language Use & Comprehension (MCQs, cloze, comprehension OEQ — NOT this analysis)
- "paper3"        → Paper 3: Listening Comprehension (MCQ-style listening questions)
- "paper4"        → Paper 4: Oral Communication (Reading aloud passage + Stimulus-based conversation picture)
- "paper1Answer"  → Model essays, marking rubric, or grade descriptors for Paper 1
- "paper3Answer"  → Answer key / listening transcripts for Paper 3
- "paper4Answer"  → Suggested responses / oral marking rubric for Paper 4

IMPORTANT: a single section (especially Paper 1 model essays — situational + 3 continuous prompts can run 4-8 pages) usually spans MULTIPLE CONSECUTIVE pages. If page N is a model essay and page N+1 is the continuation of the same essay (no new header), TAG BOTH as paper1Answer. Same applies to listening transcripts and oral rubrics — include continuation pages too.
- "cover"         → cover, instructions, blank pages, table of contents
- "other"         → anything else (Paper 2 content, irrelevant pages)

Return strict JSON listing the 1-indexed page numbers for each category. Omit cover/other.

Format:
{
  "paper1Pages": [int, ...],
  "paper3Pages": [int, ...],
  "paper4Pages": [int, ...],
  "paper1AnswerPages": [int, ...],
  "paper3AnswerPages": [int, ...],
  "paper4AnswerPages": [int, ...]
}

If a category is absent from the PDF return [].`,
    },
    ...pages.map(buf => ({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } })),
  ];
  const res = await withGeminiRetry("section-detect", () => ai().models.generateContent({
    model: SECTION_MODEL,
    contents: [{ role: "user", parts }],
    config: { temperature: 0, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "") as Partial<SectionPages>;
  const asNum = (a: unknown): number[] => Array.isArray(a) ? a.filter((n): n is number => typeof n === "number") : [];
  return {
    paper1Pages: asNum(parsed.paper1Pages),
    paper3Pages: asNum(parsed.paper3Pages),
    paper4Pages: asNum(parsed.paper4Pages),
    paper1AnswerPages: asNum(parsed.paper1AnswerPages),
    paper3AnswerPages: asNum(parsed.paper3AnswerPages),
    paper4AnswerPages: asNum(parsed.paper4AnswerPages),
  };
}

// ── Per-section OCR ──
async function ocrSection(pages: Buffer[], indices: number[], label: string): Promise<string> {
  if (indices.length === 0) return "";
  const imageParts = pagesToInline(pages, indices);
  if (imageParts.length === 0) return "";
  const res = await withGeminiRetry(`ocr-${label}`, () => ai().models.generateContent({
    model: OCR_MODEL,
    contents: [{
      role: "user",
      parts: [
        {
          text: `These are pages from the "${label}" section of a Singapore PSLE English exam (PDF pages ${indices.join(", ")}).

Please OCR each page preserving structure:
- Prefix each page with \`--- Page N ---\` (N = the real PDF page number).
- Keep question numbers, section labels, headings, bullet points.
- For any picture or illustration: insert "[Picture: <one-line description>]".
- For tables: use Markdown table syntax.
- Do NOT translate, summarise, or paraphrase — output the original text verbatim.
- No markdown code fences.

Begin OCR:`,
        },
        ...imageParts,
      ],
    }],
    config: { temperature: 0 },
  }));
  return (res.text ?? "").trim();
}

// ── Structured extraction per section ──
async function extractWritingStructure(
  pages: Buffer[],
  paper1Pages: number[],
  paper1Text: string,
): Promise<{ situationalWriting: SituationalWriting | null; continuousTheme: string | null; continuousPrompts: ContinuousPrompt[] }> {
  if (paper1Pages.length === 0 || !paper1Text) {
    return { situationalWriting: null, continuousTheme: null, continuousPrompts: [] };
  }
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 1 (Writing). Extract the structured prompts. The PDF page numbers you'll reference are: ${paper1Pages.join(", ")}.

**Section A — Situational Writing (Part 1)**
Typical layout: a STIMULUS PICTURE (poster / flyer / photograph) sits above the task. Below it: scenario paragraph, audience, purpose, and bullet points the student must address. Word count usually 100 words.
- "picturePageNum" — PDF page containing the stimulus picture (may be the same page as the task)
- "scenario" — full text of the scenario paragraph
- "audience" — recipient (Principal / teacher / friend / class / etc.)
- "purpose" — what the student must achieve
- "requirements" — bullets the student MUST address (usually 3-5)
- "wordCount" — e.g. "About 100 words"

**Section B — Continuous Writing (Part 2)**
Typical layout: a BOLD THEME heading (e.g. **A Surprise**, **Kindness**, **A Lost Item**) followed by 3 numbered picture options, then a brief task instruction.
- "continuousTheme" — the bold theme heading (~1-4 words)
- "continuousPrompts" — exactly 3 entries (optionNum 1, 2, 3) each with the PDF page where its picture lives + 1-line description of what the picture shows

Return strict JSON:
{
  "situationalWriting": {
    "picturePageNum": <int> | null,
    "scenario": "...",
    "audience": "...",
    "purpose": "...",
    "requirements": ["...", "..."],
    "wordCount": "..."
  } | null,
  "continuousTheme": "Bold theme heading" | null,
  "continuousPrompts": [
    { "optionNum": 1, "picturePageNum": <int>, "brief": "..." },
    { "optionNum": 2, "picturePageNum": <int>, "brief": "..." },
    { "optionNum": 3, "picturePageNum": <int>, "brief": "..." }
  ]
}

If a field isn't found return null / [].

OCR text:
${paper1Text}

Page images (in PDF page order):`,
    },
    ...pagesToInline(pages, paper1Pages),
  ];
  try {
    const res = await withGeminiRetry("structure-writing", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "") as { situationalWriting?: SituationalWriting; continuousTheme?: string; continuousPrompts?: ContinuousPrompt[] };
    return {
      situationalWriting: parsed.situationalWriting && typeof parsed.situationalWriting === "object"
        ? {
            picturePageNum: typeof parsed.situationalWriting.picturePageNum === "number" ? parsed.situationalWriting.picturePageNum : null,
            scenario: parsed.situationalWriting.scenario ?? "",
            audience: parsed.situationalWriting.audience ?? "",
            purpose: parsed.situationalWriting.purpose ?? "",
            requirements: Array.isArray(parsed.situationalWriting.requirements) ? parsed.situationalWriting.requirements : [],
            wordCount: parsed.situationalWriting.wordCount ?? "",
          }
        : null,
      continuousTheme: typeof parsed.continuousTheme === "string" ? parsed.continuousTheme.trim() : null,
      continuousPrompts: Array.isArray(parsed.continuousPrompts) ? parsed.continuousPrompts : [],
    };
  } catch (err) {
    console.warn(`[english-supplementary] writing structuring failed:`, err);
    return { situationalWriting: null, continuousTheme: null, continuousPrompts: [] };
  }
}

async function extractListeningStructure(
  pages: Buffer[],
  paper3Pages: number[],
  paper3Text: string,
): Promise<{ listeningMcqs: ListeningMcq[]; listeningTexts: ListeningText[] }> {
  if (paper3Pages.length === 0 || !paper3Text) return { listeningMcqs: [], listeningTexts: [] };
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 3 (Listening Comprehension). Extract whatever structure you can find — extract aggressively, prefer partial output to nothing.

Paper 3 typically has up to **20 MCQ questions** in the questions section (usually 3 options each, often images). The texts (dialogues / monologues / announcements read aloud during the exam) may appear:
- In a SEPARATE section labelled "Text 1" / "Text 2" / "Passage 1" / "Section 1" / "Transcript 1" or similar
- INTERLEAVED with the questions (text → its questions → next text)
- ONLY in the answer key / transcripts at the back (in which case the questions section won't have texts at all)

**Be liberal in what you extract:**
- If you can find ALL the questions, list them (textNum can be null if you can't determine which text they belong to).
- If you can find some texts but not all 7, list what you have.
- If you find ONLY questions (texts published elsewhere), return all MCQs and an empty listeningTexts: [].
- If you find ONLY texts (questions on a separate page already processed elsewhere), return empty listeningMcqs: [].

Return strict JSON:
{
  "listeningMcqs": [
    { "num": 1, "text": "question stem (or empty string if image-only)", "options": [{ "label": "(1)", "text": "..." }, ...], "isImageOptions": true, "textNum": 1 },
    ...
  ],
  "listeningTexts": [
    { "textNum": 1, "content": "verbatim text of the dialogue / monologue", "questionNumbers": [1, 2] },
    ...
  ]
}

Rules:
- For image-only options, set isImageOptions: true and put a 1-line description in each option's "text" prefixed with "[Picture] " (e.g. "[Picture] A boy holding a kite").
- Set textNum: null when a question's text grouping is unknown — don't invent a tag.
- Don't translate or summarise — copy verbatim.
- Do NOT use markdown code fences.

OCR text:
${paper3Text}

Page images:`,
    },
    ...pagesToInline(pages, paper3Pages),
  ];
  try {
    const res = await withGeminiRetry("structure-listening", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "") as { listeningMcqs?: ListeningMcq[]; listeningTexts?: ListeningText[] };
    return {
      listeningMcqs: Array.isArray(parsed.listeningMcqs) ? parsed.listeningMcqs : [],
      listeningTexts: Array.isArray(parsed.listeningTexts) ? parsed.listeningTexts : [],
    };
  } catch (err) {
    console.warn(`[english-supplementary] listening structuring failed:`, err);
    return { listeningMcqs: [], listeningTexts: [] };
  }
}

async function extractOralStructure(
  pages: Buffer[],
  paper4Pages: number[],
  paper4Text: string,
): Promise<{ oralDays: OralDay[] }> {
  if (paper4Pages.length === 0 || !paper4Text) return { oralDays: [] };
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 4 (Oral Communication). Extract the per-day structure.

PSLE Oral splits into TWO test days. Each day has:
1. **Reading Aloud** — a short passage (~150 words) the student reads aloud.
2. **Stimulus-based Conversation** — a single picture / photograph on a topic, plus 3 conversation prompts (typically labelled a, b, c) the examiner asks.

Look for "Day 1" / "Day 2" or "Set 1" / "Set 2" headings to split. The stimulus picture is often printed landscape (it may appear rotated 90° on the PDF page — that's fine, just identify the page number).

Return strict JSON:
{
  "oralDays": [
    {
      "day": 1,
      "readingPassage": "Full verbatim text of Day 1 reading-aloud passage",
      "stimulusPicturePageNum": <int>,
      "stimulusDescription": "1-2 sentence description of the stimulus picture",
      "conversationPrompts": ["Prompt (a) text", "Prompt (b) text", "Prompt (c) text"]
    },
    {
      "day": 2,
      "readingPassage": "...",
      "stimulusPicturePageNum": <int>,
      "stimulusDescription": "...",
      "conversationPrompts": ["...", "...", "..."]
    }
  ]
}

If only one day is present (rare) return just one entry. If no Paper 4 content, return { "oralDays": [] }.

OCR text:
${paper4Text}

Page images:`,
    },
    ...pagesToInline(pages, paper4Pages),
  ];
  try {
    const res = await withGeminiRetry("structure-oral", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "") as { oralDays?: OralDay[] };
    const oralDays = (Array.isArray(parsed.oralDays) ? parsed.oralDays : []).map(d => ({
      day: (d.day === 2 ? 2 : 1) as 1 | 2,
      readingPassage: d.readingPassage ?? "",
      stimulusPicturePageNum: typeof d.stimulusPicturePageNum === "number" ? d.stimulusPicturePageNum : null,
      stimulusDescription: d.stimulusDescription ?? "",
      conversationPrompts: Array.isArray(d.conversationPrompts) ? d.conversationPrompts : [],
    }));
    return { oralDays };
  } catch (err) {
    console.warn(`[english-supplementary] oral structuring failed:`, err);
    return { oralDays: [] };
  }
}

async function extractWritingAnswers(paper1AnswerText: string): Promise<{ situationalModel: string | null; continuousModel: string | null }> {
  if (!paper1AnswerText) return { situationalModel: null, continuousModel: null };
  try {
    const res = await withGeminiRetry("structure-writing-answers", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `Below is OCR text from the model-answer / marking-rubric section for PSLE English Paper 1 (Writing). Extract the model essays for Section A (Situational Writing) and Section B (Continuous Writing).

CRITICAL — DO NOT TRUNCATE:
- Output the COMPLETE verbatim text of every model essay you find.
- Each essay is typically 150-300 words. If there are 3 continuous-writing model essays (one per picture prompt), include ALL THREE, separated by "\\n\\n--- ESSAY 2 ---\\n\\n" and "\\n\\n--- ESSAY 3 ---\\n\\n" — never collapse them.
- Preserve original paragraph breaks and punctuation. No summarising, no paraphrasing.

Return strict JSON:
{
  "situationalModel": "<complete situational essay verbatim>" | null,
  "continuousModel": "<complete continuous essay/essays verbatim, with separators between multiples>" | null
}

OCR text:
${paper1AnswerText}` }] }],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        // Bump from the default ~8k so 3 full continuous essays
        // (~150-300 words each) fit comfortably without truncation.
        maxOutputTokens: 32768,
      },
    }));
    const parsed = JSON.parse(res.text ?? "") as { situationalModel?: string; continuousModel?: string };
    return {
      situationalModel: typeof parsed.situationalModel === "string" ? parsed.situationalModel.trim() : null,
      continuousModel: typeof parsed.continuousModel === "string" ? parsed.continuousModel.trim() : null,
    };
  } catch (err) {
    console.warn(`[english-supplementary] writing answers structuring failed:`, err);
    return { situationalModel: null, continuousModel: null };
  }
}

async function extractOralAnswers(paper4AnswerText: string): Promise<OralModelAnswer[]> {
  if (!paper4AnswerText) return [];
  try {
    const res = await withGeminiRetry("structure-oral-answers", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `Below is OCR text from the model-answer section for PSLE English Paper 4 (Oral, Stimulus-based Conversation). Extract one model answer per question per day.

Typical layout: Day 1 (a) / Day 1 (b) / Day 1 (c) / Day 2 (a) / Day 2 (b) / Day 2 (c), each with a paragraph of sample student response.

Return strict JSON:
{
  "oralModelAnswers": [
    { "day": 1, "q": "a", "answer": "Full text of the model answer for Day 1 question (a)" },
    { "day": 1, "q": "b", "answer": "..." },
    { "day": 1, "q": "c", "answer": "..." },
    { "day": 2, "q": "a", "answer": "..." },
    { "day": 2, "q": "b", "answer": "..." },
    { "day": 2, "q": "c", "answer": "..." }
  ]
}

Preserve original phrasing. Skip entries that don't have a clear model answer.

OCR text:
${paper4AnswerText}` }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "") as { oralModelAnswers?: OralModelAnswer[] };
    return Array.isArray(parsed.oralModelAnswers) ? parsed.oralModelAnswers : [];
  } catch (err) {
    console.warn(`[english-supplementary] oral answers structuring failed:`, err);
    return [];
  }
}

async function extractListeningAnswers(paper3AnswerText: string): Promise<ListeningAnswer[]> {
  if (!paper3AnswerText) return [];
  try {
    const res = await withGeminiRetry("structure-listening-answers", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `Below is OCR text from the answer-key section for PSLE English Paper 3 (Listening Comprehension). Extract the 20 answer key entries.

Return strict JSON:
{
  "listeningAnswers": [ { "num": 1, "answer": "(1)" | "A" | ... }, ... ]
}

Preserve the original formatting of the answer (parentheses, letter, etc.). For any unclear answer, return "?".

OCR text:
${paper3AnswerText}` }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "") as { listeningAnswers?: ListeningAnswer[] };
    return Array.isArray(parsed.listeningAnswers) ? parsed.listeningAnswers : [];
  } catch (err) {
    console.warn(`[english-supplementary] listening answers structuring failed:`, err);
    return [];
  }
}

// ── Full pipeline ──
export async function extractSupplementaryFromPdf(
  pdfBuffer: Buffer,
  onProgress?: (status: string) => void | Promise<void>,
): Promise<SupplementaryExtraction> {
  onProgress?.("rendering");
  const pages = await renderPdfToJpegs(pdfBuffer, 1600, 80);

  onProgress?.("sectioning");
  const sections = await detectSections(pages);

  onProgress?.("ocr-paper1");
  const paper1Text = await ocrSection(pages, sections.paper1Pages, "Paper 1 Writing");
  onProgress?.("ocr-paper3");
  const paper3Text = await ocrSection(pages, sections.paper3Pages, "Paper 3 Listening");
  onProgress?.("ocr-paper4");
  const paper4Text = await ocrSection(pages, sections.paper4Pages, "Paper 4 Oral");
  onProgress?.("ocr-paper1-answer");
  const paper1AnswerText = await ocrSection(pages, sections.paper1AnswerPages, "Paper 1 Answers");
  onProgress?.("ocr-paper3-answer");
  const paper3AnswerText = await ocrSection(pages, sections.paper3AnswerPages, "Paper 3 Answers");
  onProgress?.("ocr-paper4-answer");
  const paper4AnswerText = await ocrSection(pages, sections.paper4AnswerPages, "Paper 4 Answers");

  onProgress?.("structuring");
  const [writing, listening, oral, writingAns, listeningAns, oralAns] = await Promise.all([
    extractWritingStructure(pages, sections.paper1Pages, paper1Text),
    extractListeningStructure(pages, sections.paper3Pages, paper3Text),
    extractOralStructure(pages, sections.paper4Pages, paper4Text),
    extractWritingAnswers(paper1AnswerText),
    extractListeningAnswers(paper3AnswerText),
    extractOralAnswers(paper4AnswerText),
  ]);

  return {
    ...sections,
    pageCount: pages.length,
    paper1Text, paper3Text, paper4Text,
    paper1AnswerText, paper3AnswerText, paper4AnswerText,
    structured: {
      situationalWriting: writing.situationalWriting,
      continuousTheme: writing.continuousTheme,
      continuousPrompts: writing.continuousPrompts,
      listeningMcqs: listening.listeningMcqs,
      listeningTexts: listening.listeningTexts,
      oralDays: oral.oralDays,
      situationalModel: writingAns.situationalModel,
      continuousModel: writingAns.continuousModel,
      listeningAnswers: listeningAns,
      oralModelAnswers: oralAns,
    },
  };
}

// ── Auto-crop pictures step ──
// After the structured extraction lands, render the picture pages
// and crop each into its own file on the volume. Files:
//   {year}_situational_picture.jpg
//   {year}_continuous_<1|2|3>.jpg
//   {year}_oral_day<1|2>_stimulus.jpg   (rotated 90° CW since PSLE
//                                         oral stimuli are printed
//                                         landscape on a portrait page)
//
// Idempotent — overwrites existing files. Best-effort — a single
// crop failure won't abort the others.
export async function autoCropPictures(
  pdfBuffer: Buffer,
  structured: StructuredExtraction,
  outDir: string,
  yearLabel: string,
): Promise<{ savedCount: number; errors: string[] }> {
  const fs = await import("fs/promises");
  await fs.mkdir(outDir, { recursive: true });
  const tasks: Array<{ kind: string; pageNum: number; rotate: number; hint: string }> = [];

  if (structured.situationalWriting?.picturePageNum) {
    tasks.push({
      kind: "situational",  // matches the picture route's croppedPath naming
      pageNum: structured.situationalWriting.picturePageNum,
      rotate: 0,
      hint: "the main stimulus picture / poster / flyer at the top of the situational-writing task",
    });
  }
  for (const cp of structured.continuousPrompts) {
    if (cp.picturePageNum) {
      tasks.push({
        kind: `continuous_${cp.optionNum}`,
        pageNum: cp.picturePageNum,
        rotate: 0,
        hint: `the picture labelled option ${cp.optionNum} of the continuous-writing prompts`,
      });
    }
  }
  for (const day of structured.oralDays) {
    if (day.stimulusPicturePageNum) {
      tasks.push({
        kind: `oral_day${day.day}_stimulus`,
        pageNum: day.stimulusPicturePageNum,
        rotate: 90,
        hint: "the stimulus-based conversation picture (often printed landscape — sideways on the page)",
      });
    }
  }

  // Render the WHOLE PDF once (avoids pdfjs.getDocument() being
  // called repeatedly — that intermittently throws "Invalid page
  // request" on retries even when the first render succeeded).
  // Then slice out the pages we need.
  const uniquePages = [...new Set(tasks.map(t => t.pageNum))];
  const pageBuffers = new Map<number, Buffer>();
  let allRendered: Buffer[];
  try {
    allRendered = await renderPdfToJpegs(pdfBuffer, 2400, 90);
  } catch (e) {
    console.warn(`[auto-crop] PDF render failed entirely — skipping all picture crops:`, e);
    return { savedCount: 0, errors: [`PDF render failed: ${(e as Error).message}`] };
  }
  for (const p of uniquePages) {
    if (p < 1 || p > allRendered.length) {
      console.warn(`[auto-crop] page ${p} out of range (PDF has ${allRendered.length} pages) — skipping`);
      continue;
    }
    pageBuffers.set(p, allRendered[p - 1]);
  }

  let savedCount = 0;
  const errors: string[] = [];
  for (const task of tasks) {
    const pageJpeg = pageBuffers.get(task.pageNum);
    if (!pageJpeg) { errors.push(`${task.kind}: no page render`); continue; }
    try {
      const bounds = await detectPictureBounds(pageJpeg, task.hint);
      const cropped = await cropPageImage(pageJpeg, bounds, 90, task.rotate);
      const path = await import("path");
      const out = path.join(outDir, `${yearLabel}_${task.kind}.jpg`);
      await fs.writeFile(out, cropped);
      savedCount++;
    } catch (e) {
      errors.push(`${task.kind}: ${(e as Error).message}`);
    }
  }
  return { savedCount, errors };
}

// Listening MCQs have picture-based answer options (3 small images
// per question), so we crop each MCQ as one image — stem + 3 options
// together — instead of trying to describe the options as text.
// Files: <year>_listening_q<N>.jpg.
//
// Caller supplies the rendered pages array (reused from extraction
// or auto-crop) and the paper3Pages page numbers. Iterates each
// listening page, asks Gemini to locate each numbered question
// block on that page, crops, saves.
export async function autoCropListeningQuestions(
  pdfBuffer: Buffer,
  paper3Pages: number[],
  outDir: string,
  yearLabel: string,
): Promise<{ savedCount: number; errors: string[]; questionNumbers: number[] }> {
  const fs = await import("fs/promises");
  const path = await import("path");
  if (paper3Pages.length === 0) return { savedCount: 0, errors: [], questionNumbers: [] };
  await fs.mkdir(outDir, { recursive: true });

  let allRendered: Buffer[];
  try {
    allRendered = await renderPdfToJpegs(pdfBuffer, 2400, 90);
  } catch (e) {
    return { savedCount: 0, errors: [`PDF render failed: ${(e as Error).message}`], questionNumbers: [] };
  }

  let savedCount = 0;
  const errors: string[] = [];
  const seenNums = new Set<number>();
  for (const p of paper3Pages) {
    if (p < 1 || p > allRendered.length) continue;
    const pageJpeg = allRendered[p - 1];
    const questions = await detectListeningQuestionsOnPage(pageJpeg);
    if (questions.length === 0) continue;
    for (const q of questions) {
      if (seenNums.has(q.num)) continue; // de-dupe in case adjacent pages overlap
      seenNums.add(q.num);
      try {
        // Pad 2% around the detected block — listening MCQ blocks
        // are tight, picture-heavy regions; a bigger pad than usual
        // risks merging adjacent questions.
        const pad = 0.02;
        const bounds = {
          left: Math.max(0, q.left - pad),
          top: Math.max(0, q.top - pad),
          width: Math.min(1 - Math.max(0, q.left - pad), q.width + 2 * pad),
          height: Math.min(1 - Math.max(0, q.top - pad), q.height + 2 * pad),
        };
        const cropped = await cropPageImage(pageJpeg, bounds, 90, 0);
        const out = path.join(outDir, `${yearLabel}_listening_q${q.num}.jpg`);
        await fs.writeFile(out, cropped);
        savedCount++;
      } catch (e) {
        errors.push(`listening_q${q.num}: ${(e as Error).message}`);
      }
    }
  }
  return { savedCount, errors, questionNumbers: [...seenNums].sort((a, b) => a - b) };
}

// Helpers exported so the listening "re-extract all" endpoint can
// re-OCR + re-structure without re-running the full pipeline.
export async function ocrPaperSection(
  pdfBuffer: Buffer,
  paperPages: number[],
  label: string,
): Promise<string> {
  if (paperPages.length === 0) return "";
  const pages = await renderPdfToJpegs(pdfBuffer, 1600, 80);
  return ocrSection(pages, paperPages, label);
}

export async function extractListeningStructureFromText(
  pdfBuffer: Buffer,
  paper3Pages: number[],
  paper3Text: string,
): Promise<{ listeningMcqs: ListeningMcq[]; listeningTexts: ListeningText[] }> {
  if (paper3Pages.length === 0) return { listeningMcqs: [], listeningTexts: [] };
  const pages = await renderPdfToJpegs(pdfBuffer, 1600, 80);
  return extractListeningStructure(pages, paper3Pages, paper3Text);
}

// ── Per-section reextract (admin override) ──
export type SectionKey = "paper1" | "paper3" | "paper4" | "paper1Answer" | "paper3Answer" | "paper4Answer";

export type SectionReextract = {
  section: SectionKey;
  pages: number[];
  text: string;
  situationalWriting?: SituationalWriting | null;
  continuousTheme?: string | null;
  continuousPrompts?: ContinuousPrompt[];
  listeningMcqs?: ListeningMcq[];
  listeningTexts?: ListeningText[];
  oralDays?: OralDay[];
  situationalModel?: string | null;
  continuousModel?: string | null;
  listeningAnswers?: ListeningAnswer[];
  oralModelAnswers?: OralModelAnswer[];
};

const SECTION_LABEL: Record<SectionKey, string> = {
  paper1: "Paper 1 Writing",
  paper3: "Paper 3 Listening",
  paper4: "Paper 4 Oral",
  paper1Answer: "Paper 1 Answers",
  paper3Answer: "Paper 3 Answers",
  paper4Answer: "Paper 4 Answers",
};

export async function reextractSection(
  pdfBuffer: Buffer,
  section: SectionKey,
  pages: number[],
): Promise<SectionReextract> {
  if (pages.length === 0) throw new Error("pages array is empty");
  const allPages = await renderPdfToJpegs(pdfBuffer, 1600, 80);
  const bad = pages.filter(p => p < 1 || p > allPages.length);
  if (bad.length) throw new Error(`pages out of range (PDF has ${allPages.length}): ${bad.join(", ")}`);

  const text = await ocrSection(allPages, pages, SECTION_LABEL[section]);
  const out: SectionReextract = { section, pages, text };

  if (section === "paper1") {
    const s = await extractWritingStructure(allPages, pages, text);
    out.situationalWriting = s.situationalWriting;
    out.continuousTheme = s.continuousTheme;
    out.continuousPrompts = s.continuousPrompts;
  } else if (section === "paper3") {
    const s = await extractListeningStructure(allPages, pages, text);
    out.listeningMcqs = s.listeningMcqs;
    out.listeningTexts = s.listeningTexts;
  } else if (section === "paper4") {
    const s = await extractOralStructure(allPages, pages, text);
    out.oralDays = s.oralDays;
  } else if (section === "paper1Answer") {
    const s = await extractWritingAnswers(text);
    out.situationalModel = s.situationalModel;
    out.continuousModel = s.continuousModel;
  } else if (section === "paper3Answer") {
    out.listeningAnswers = await extractListeningAnswers(text);
  } else if (section === "paper4Answer") {
    out.oralModelAnswers = await extractOralAnswers(text);
  }
  return out;
}
