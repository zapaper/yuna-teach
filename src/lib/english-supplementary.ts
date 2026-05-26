// Extraction pipeline for PSLE English Paper 1 (Writing), Paper 3
// (Listening Comprehension MCQs), and Paper 4 (Oral). Mirrors the
// Chinese pipeline in src/lib/chinese-supplementary.ts but uses
// English-specific prompts and reflects the different paper
// structure (Section A Situational + Section B Continuous Writing,
// listening MCQs, oral reading + stimulus).

import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { renderPdfToJpegs } from "./pdf-server";

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
  const pages = await renderPdfToJpegs(pdfBuffer, maxDim, quality);
  if (pageNumber < 1 || pageNumber > pages.length) {
    throw new Error(`pageNumber ${pageNumber} out of range (1..${pages.length})`);
  }
  return pages[pageNumber - 1];
}

export async function cropPageImage(
  pageJpeg: Buffer,
  fractions: { left: number; top: number; width: number; height: number },
  outQuality = 90,
): Promise<Buffer> {
  const meta = await sharp(pageJpeg).metadata();
  const W = meta.width ?? 0; const H = meta.height ?? 0;
  if (!W || !H) throw new Error("could not read source image dimensions");
  const left = Math.max(0, Math.round(fractions.left * W));
  const top = Math.max(0, Math.round(fractions.top * H));
  const width = Math.min(W - left, Math.round(fractions.width * W));
  const height = Math.min(H - top, Math.round(fractions.height * H));
  if (width <= 0 || height <= 0) throw new Error("crop dimensions are zero");
  return sharp(pageJpeg)
    .extract({ left, top, width, height })
    .jpeg({ quality: outQuality, chromaSubsampling: "4:4:4" })
    .toBuffer();
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
  scenario: string;            // e.g. "You are writing an email to your school principal..."
  audience: string;            // recipient (Principal / teacher / friend / etc.)
  purpose: string;             // e.g. "Suggest improvements to the canteen menu"
  requirements: string[];      // bullet points the student MUST address (3-5 typically)
  wordCount: string;           // e.g. "100-150 words"
};
export type ContinuousPrompt = {
  optionNum: number;            // 1..3
  picturePageNum: number | null;
  brief: string;                // 1-line description of what the picture shows
};
export type ListeningMcqOption = { label: string; text: string };
export type ListeningMcq = {
  num: number;
  text: string;
  options: ListeningMcqOption[];
  isImageOptions: boolean;
};
export type OralStimulusPicture = {
  picturePageNum: number | null;
  description: string;
  conversationPrompts: string[];   // e.g. ["What do you think the boy is doing?", ...]
};
export type ListeningAnswer = { num: number; answer: string };
export type StructuredExtraction = {
  situationalWriting: SituationalWriting | null;
  continuousPrompts: ContinuousPrompt[];
  listeningMcqs: ListeningMcq[];
  oralReadingPassage: string | null;
  oralStimulusPicture: OralStimulusPicture | null;
  situationalModel: string | null;
  continuousModel: string | null;
  listeningAnswers: ListeningAnswer[];
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
): Promise<{ situationalWriting: SituationalWriting | null; continuousPrompts: ContinuousPrompt[] }> {
  if (paper1Pages.length === 0 || !paper1Text) {
    return { situationalWriting: null, continuousPrompts: [] };
  }
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 1 (Writing). Extract the structured prompts.

Paper 1 has two sections:

**Section A — Situational Writing** (1 prompt, ~100-150 words):
- A scenario (e.g. "You are the school's Eco Captain…")
- An audience (recipient — principal, teacher, friend, etc.)
- A purpose (what the student must persuade/inform/request)
- A list of "must address" requirements / bullet points (typically 3-5)
- Word count requirement

**Section B — Continuous Writing** (3 picture prompts to choose from, ~150 words):
- 3 numbered options, each with one picture + a 1-line theme/brief
- Student picks ONE picture and writes a story / personal recount

Return strict JSON:
{
  "situationalWriting": {
    "scenario": "Full text of the scenario paragraph",
    "audience": "e.g. School Principal",
    "purpose": "What the student must achieve in the writing",
    "requirements": ["bullet 1", "bullet 2", "bullet 3"],
    "wordCount": "e.g. 100-150 words"
  } | null,
  "continuousPrompts": [
    { "optionNum": 1, "picturePageNum": <int>, "brief": "1-line description of what the picture shows" },
    { "optionNum": 2, "picturePageNum": <int>, "brief": "..." },
    { "optionNum": 3, "picturePageNum": <int>, "brief": "..." }
  ]
}

If a field isn't found, return null (for situationalWriting) or [] (for continuousPrompts).

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
    const parsed = JSON.parse(res.text ?? "") as { situationalWriting?: SituationalWriting; continuousPrompts?: ContinuousPrompt[] };
    return {
      situationalWriting: parsed.situationalWriting && typeof parsed.situationalWriting === "object"
        ? {
            scenario: parsed.situationalWriting.scenario ?? "",
            audience: parsed.situationalWriting.audience ?? "",
            purpose: parsed.situationalWriting.purpose ?? "",
            requirements: Array.isArray(parsed.situationalWriting.requirements) ? parsed.situationalWriting.requirements : [],
            wordCount: parsed.situationalWriting.wordCount ?? "",
          }
        : null,
      continuousPrompts: Array.isArray(parsed.continuousPrompts) ? parsed.continuousPrompts : [],
    };
  } catch (err) {
    console.warn(`[english-supplementary] writing structuring failed:`, err);
    return { situationalWriting: null, continuousPrompts: [] };
  }
}

async function extractListeningStructure(
  pages: Buffer[],
  paper3Pages: number[],
  paper3Text: string,
): Promise<{ listeningMcqs: ListeningMcq[] }> {
  if (paper3Pages.length === 0 || !paper3Text) return { listeningMcqs: [] };
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 3 (Listening Comprehension). Extract the MCQ structure.

PSLE English Paper 3 is ~20 listening MCQs. Each question has 3-4 answer options. Options are usually short phrases; sometimes they're images (in which case describe each image briefly).

Return strict JSON:
{
  "listeningMcqs": [
    { "num": 1, "text": "the question stem", "options": [{ "label": "(1)", "text": "..." }, ...], "isImageOptions": false },
    ...
  ]
}

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
    const parsed = JSON.parse(res.text ?? "") as { listeningMcqs?: ListeningMcq[] };
    return { listeningMcqs: Array.isArray(parsed.listeningMcqs) ? parsed.listeningMcqs : [] };
  } catch (err) {
    console.warn(`[english-supplementary] listening structuring failed:`, err);
    return { listeningMcqs: [] };
  }
}

async function extractOralStructure(
  pages: Buffer[],
  paper4Pages: number[],
  paper4Text: string,
): Promise<{ oralReadingPassage: string | null; oralStimulusPicture: OralStimulusPicture | null }> {
  if (paper4Pages.length === 0 || !paper4Text) return { oralReadingPassage: null, oralStimulusPicture: null };
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `Below is OCR text and page images for PSLE English Paper 4 (Oral Communication). Extract the structured components.

Paper 4 has two parts:
- **Reading Aloud**: a short passage the student reads aloud (~150 words).
- **Stimulus-based Conversation**: one picture/photo on a topic, followed by 2-3 conversation prompts/questions from the examiner.

Return strict JSON:
{
  "oralReadingPassage": "Full verbatim text of the reading passage" | null,
  "oralStimulusPicture": {
    "picturePageNum": <int>,
    "description": "1-2 sentence description of what the picture shows",
    "conversationPrompts": ["Prompt 1", "Prompt 2", "Prompt 3"]
  } | null
}

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
    const parsed = JSON.parse(res.text ?? "") as { oralReadingPassage?: string; oralStimulusPicture?: OralStimulusPicture };
    return {
      oralReadingPassage: typeof parsed.oralReadingPassage === "string" ? parsed.oralReadingPassage.trim() : null,
      oralStimulusPicture: parsed.oralStimulusPicture && typeof parsed.oralStimulusPicture === "object" ? {
        picturePageNum: typeof parsed.oralStimulusPicture.picturePageNum === "number" ? parsed.oralStimulusPicture.picturePageNum : null,
        description: parsed.oralStimulusPicture.description ?? "",
        conversationPrompts: Array.isArray(parsed.oralStimulusPicture.conversationPrompts) ? parsed.oralStimulusPicture.conversationPrompts : [],
      } : null,
    };
  } catch (err) {
    console.warn(`[english-supplementary] oral structuring failed:`, err);
    return { oralReadingPassage: null, oralStimulusPicture: null };
  }
}

async function extractWritingAnswers(paper1AnswerText: string): Promise<{ situationalModel: string | null; continuousModel: string | null }> {
  if (!paper1AnswerText) return { situationalModel: null, continuousModel: null };
  try {
    const res = await withGeminiRetry("structure-writing-answers", () => ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `Below is OCR text from the model-answer / marking-rubric section for PSLE English Paper 1 (Writing). Extract the model essays for Section A (Situational Writing) and Section B (Continuous Writing).

Return strict JSON:
{
  "situationalModel": "Full text of the situational-writing model essay" | null,
  "continuousModel": "Full text(s) of the continuous-writing model essay(s) — if there are multiple, concatenate with \\n\\n--- separators" | null
}

Preserve original paragraphs and punctuation. Do not summarise.

OCR text:
${paper1AnswerText}` }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
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
  const [writing, listening, oral, writingAns, listeningAns] = await Promise.all([
    extractWritingStructure(pages, sections.paper1Pages, paper1Text),
    extractListeningStructure(pages, sections.paper3Pages, paper3Text),
    extractOralStructure(pages, sections.paper4Pages, paper4Text),
    extractWritingAnswers(paper1AnswerText),
    extractListeningAnswers(paper3AnswerText),
  ]);

  return {
    ...sections,
    pageCount: pages.length,
    paper1Text, paper3Text, paper4Text,
    paper1AnswerText, paper3AnswerText, paper4AnswerText,
    structured: {
      situationalWriting: writing.situationalWriting,
      continuousPrompts: writing.continuousPrompts,
      listeningMcqs: listening.listeningMcqs,
      oralReadingPassage: oral.oralReadingPassage,
      oralStimulusPicture: oral.oralStimulusPicture,
      situationalModel: writingAns.situationalModel,
      continuousModel: writingAns.continuousModel,
      listeningAnswers: listeningAns,
    },
  };
}

// ── Per-section reextract (admin override) ──
export type SectionKey = "paper1" | "paper3" | "paper4" | "paper1Answer" | "paper3Answer" | "paper4Answer";

export type SectionReextract = {
  section: SectionKey;
  pages: number[];
  text: string;
  situationalWriting?: SituationalWriting | null;
  continuousPrompts?: ContinuousPrompt[];
  listeningMcqs?: ListeningMcq[];
  oralReadingPassage?: string | null;
  oralStimulusPicture?: OralStimulusPicture | null;
  situationalModel?: string | null;
  continuousModel?: string | null;
  listeningAnswers?: ListeningAnswer[];
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
    out.continuousPrompts = s.continuousPrompts;
  } else if (section === "paper3") {
    const s = await extractListeningStructure(allPages, pages, text);
    out.listeningMcqs = s.listeningMcqs;
  } else if (section === "paper4") {
    const s = await extractOralStructure(allPages, pages, text);
    out.oralReadingPassage = s.oralReadingPassage;
    out.oralStimulusPicture = s.oralStimulusPicture;
  } else if (section === "paper1Answer") {
    const s = await extractWritingAnswers(text);
    out.situationalModel = s.situationalModel;
    out.continuousModel = s.continuousModel;
  } else if (section === "paper3Answer") {
    out.listeningAnswers = await extractListeningAnswers(text);
  }
  // paper4Answer: no structured field today — just the raw OCR text.
  return out;
}
