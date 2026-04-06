import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) {
    // Set a 3-minute HTTP timeout so extraction calls never hang indefinitely.
    // Large English papers with many images can take 2+ minutes on the first call.
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 180000 } });
  }
  return _ai;
}

/** Retryable network error codes — ECONNRESET means Railway's proxy cut the connection mid-request. */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;
  // HTTP 503 / 429 / 504 from Gemini
  if (typeof e.status === "number" && (e.status === 503 || e.status === 429 || e.status === 504)) return true;
  return false;
}

type GenerateContentParams = Parameters<ReturnType<typeof getAI>["models"]["generateContent"]>[0];

async function generateContentWithRetry(
  params: GenerateContentParams,
  maxRetries = 2,
  delayMs = 5000
): Promise<Awaited<ReturnType<ReturnType<typeof getAI>["models"]["generateContent"]>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getAI().models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      const wait = delayMs * (attempt + 1);
      console.warn(`[Gemini] Network error (${(err as Record<string, unknown>).code ?? "unknown"}), retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Auto-detect question type from image
// ---------------------------------------------------------------------------

const AUTO_DETECT_PROMPT = `Look at this exam question image.
Determine if it is an MCQ (Multiple Choice Question) or an OEQ (Open-Ended / Written Question).

An MCQ has exactly four answer options clearly labeled (1), (2), (3), (4) OR (A), (B), (C), (D).
An OEQ has no such labeled options — the student must write their own answer.

Return ONLY valid JSON:
{ "type": "mcq" }
or
{ "type": "oeq" }`;

export async function detectQuestionType(imageBase64: string): Promise<"mcq" | "oeq"> {
  try {
    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: AUTO_DETECT_PROMPT },
        ],
      }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const parsed = JSON.parse((response.text ?? "{}").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
    return parsed.type === "mcq" ? "mcq" : "oeq";
  } catch {
    return "oeq"; // fallback: treat as OEQ if detection fails
  }
}

// ---------------------------------------------------------------------------
// Math MCQ transcription — converts a cropped question image to clean text
// ---------------------------------------------------------------------------

export type DiagramBounds = { top: number; left: number; bottom: number; right: number };

/** Strip leading question number from stem, e.g. "21. Find..." → "Find..." */
function stripQuestionNumber(stem: string): string {
  return stem.replace(/^\s*(?:Q\.?\s*)?(\d{1,3})\s*[.)]\s*/i, "").trim();
}

const DIAGRAM_BOUNDS_INSTRUCTION = `
- diagram: If the question contains a figure, shape, number line, bar model, table, or any visual element that is NOT just text — return its bounding box as percentages of the full image height/width. Use null if there is no diagram.
  { "top": 0-100, "left": 0-100, "bottom": 0-100, "right": 0-100 }
  Be generous — include a small margin around the diagram so nothing is clipped.
  If there is a diagram, do NOT write "[diagram]" in the stem — just reference it naturally (e.g. "In the figure,").`;

const MATH_MCQ_TRANSCRIPTION_PROMPT = `You are transcribing a Singapore primary school Mathematics MCQ question from an exam paper image.

The image shows ONE question with a question stem and four answer options labeled (1), (2), (3), (4).

Your task:
1. Extract the FULL question stem — include all numbers, units, mathematical expressions
2. Extract all four answer options exactly as printed
3. Detect any diagram/figure in the question
${DIAGRAM_BOUNDS_INSTRUCTION}
4. Check if the answer options are IMAGE-BASED (shapes, diagrams, figures, bar models, number lines, visual patterns, etc. that cannot be fully represented as text). If so, return bounding boxes for each option in "optionBounds".

Rules:
- Do NOT include the question number at the start of the stem (e.g. "21.", "5)", "Q3.") — start with the actual question text
- Preserve mathematical notation (e.g. "1/2", "3.5 cm²", "2 × 4")
- Include units in options if present (e.g. "12 cm", "0.75")
- Do NOT include the "(1)" / "(2)" labels in the option text — just the option content
- If an option IS a visual/image (shape, diagram, figure), put a brief text description in options (e.g. "Triangle with sides 3cm, 4cm") AND provide its bounding box in optionBounds
- optionBounds: array of 4 bounding boxes (one per option), each as { "top": 0-100, "left": 0-100, "bottom": 0-100, "right": 0-100 } or null if that option is text-only. Set entire array to null if ALL options are plain text.

Return ONLY valid JSON, no markdown fences:
{
  "stem": "full question text here",
  "options": ["option 1 text", "option 2 text", "option 3 text", "option 4 text"],
  "diagram": { "top": 10, "left": 5, "bottom": 45, "right": 95 },
  "optionBounds": [{ "top": 60, "left": 5, "bottom": 70, "right": 45 }, null, null, null]
}
(set "diagram" to null if no diagram, set "optionBounds" to null if all options are plain text)`;

export async function transcribeMathMcqQuestion(
  imageBase64: string
): Promise<{
  stem: string;
  options: [string, string, string, string];
  diagram: DiagramBounds | null;
  optionBounds: (DiagramBounds | null)[] | null;
}> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: MATH_MCQ_TRANSCRIPTION_PROMPT },
        ],
      },
    ],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  const d = parsed.diagram;
  const ob = parsed.optionBounds;
  return {
    stem: stripQuestionNumber(String(parsed.stem ?? "")),
    options: [
      String(parsed.options?.[0] ?? ""),
      String(parsed.options?.[1] ?? ""),
      String(parsed.options?.[2] ?? ""),
      String(parsed.options?.[3] ?? ""),
    ],
    diagram: (d && typeof d === "object") ? { top: +d.top, left: +d.left, bottom: +d.bottom, right: +d.right } : null,
    optionBounds: Array.isArray(ob)
      ? ob.map((b: unknown) => (b && typeof b === "object") ? { top: +(b as DiagramBounds).top, left: +(b as DiagramBounds).left, bottom: +(b as DiagramBounds).bottom, right: +(b as DiagramBounds).right } : null)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Math open-ended transcription
// ---------------------------------------------------------------------------

const MATH_OPEN_ENDED_TRANSCRIPTION_PROMPT = `You are transcribing a Singapore primary school Mathematics open-ended question from an exam paper image.

The image shows ONE question. It may have sub-parts labeled (a), (b), (c), etc., or it may be a single question with no sub-parts.

Your task:
1. Extract the FULL question stem — this is ALL the text that appears BEFORE any sub-part labels like (a), (b), (c). This preamble/context is CRITICAL — it sets up the question and gives context to the sub-parts. Do NOT skip it.
   Examples of stems:
   - "The table below shows the number of apples sold over 4 days."
   - "Ali had 120 stickers. He gave 1/3 of them to Ben."
   - "A rectangular tank measures 30 cm by 20 cm by 15 cm."
   If the question goes straight from the question number into (a) with NO preamble text, use an empty string for stem.
2. Extract each sub-part label and its text separately
3. If there are NO sub-parts, leave the subparts array empty and put the full question in stem
4. Detect any diagram/figure in the question
${DIAGRAM_BOUNDS_INSTRUCTION}

Rules:
- Do NOT include the question number at the start of the stem (e.g. "21.", "5)", "Q3.") — start with the actual question text
- ALWAYS include ALL preamble/context text before (a) in the stem — never skip introductory sentences, given information, or setup text
- Preserve all mathematical notation exactly (e.g. "1/2", "3.5 cm²", "2 × 4", "∠ABC")
- Include units (e.g. "cm", "kg", "m²")
- Do NOT include blank answer lines or answer boxes in the text
- Sub-part labels are like "(a)", "(b)", "(c)" — extract just the letter as the label
- If marks are shown per sub-part (e.g. "[2]", "[3 marks]", "[2m]" next to each part), include them at the END of that sub-part's text in the format "[Nmarks]" (e.g. "Find the area of the triangle. [2marks]"). ALWAYS use this exact format: [Nmarks] with no space.
- For questions WITHOUT sub-parts, include the marks at the end of the stem in the same format (e.g. "Calculate the total cost. [4marks]")

Return ONLY valid JSON, no markdown fences:
{
  "stem": "ALL preamble/context text before the sub-parts (e.g. 'The table shows the number of students in each class.')",
  "subparts": [
    { "label": "a", "text": "sub-question text here [2marks]" },
    { "label": "b", "text": "sub-question text here [3marks]" }
  ],
  "diagram": { "top": 10, "left": 5, "bottom": 45, "right": 95 }
}
(set "diagram" to null if no diagram; if no sub-parts use "subparts": [])`;

export type OpenEndedSubpart = { label: string; text: string };
export type TranscribedOpenEnded = { stem: string; subparts: OpenEndedSubpart[]; diagram: DiagramBounds | null };

export async function transcribeMathOpenEndedQuestion(
  imageBase64: string
): Promise<TranscribedOpenEnded> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: MATH_OPEN_ENDED_TRANSCRIPTION_PROMPT },
        ],
      },
    ],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  const d = parsed.diagram;
  return {
    stem: stripQuestionNumber(String(parsed.stem ?? "")),
    subparts: Array.isArray(parsed.subparts)
      ? parsed.subparts.map((p: Record<string, unknown>) => ({
          label: String(p.label ?? ""),
          text: String(p.text ?? ""),
        }))
      : [],
    diagram: (d && typeof d === "object") ? { top: +d.top, left: +d.left, bottom: +d.bottom, right: +d.right } : null,
  };
}

// ---------------------------------------------------------------------------
// Science MCQ transcription
// ---------------------------------------------------------------------------

const SCIENCE_MCQ_TRANSCRIPTION_PROMPT = `You are transcribing a Singapore primary school Science MCQ question from an exam paper image.

The image shows ONE question with a question stem and four answer options labeled (1), (2), (3), (4).

Your task:
1. Extract the FULL question stem — include all context, labels, descriptions
2. Extract all four answer options exactly as printed
3. Detect any diagram/figure in the question
${DIAGRAM_BOUNDS_INSTRUCTION}
4. Check if the answer options are IMAGE-BASED (diagrams of apparatus, animals, plants, life cycles, food chains, graphs, etc. that cannot be fully represented as text). If so, return bounding boxes for each option in "optionBounds".

Rules:
- Do NOT include the question number at the start of the stem (e.g. "21.", "5)", "Q3.") — start with the actual question text
- Preserve all scientific terms exactly (e.g. "photosynthesis", "condensation", "Newton", "km/h")
- Include units in options if present (e.g. "60 km/h", "200 g")
- Do NOT include the "(1)" / "(2)" labels in the option text — just the option content
- If an option IS a visual/image (diagram, apparatus, organism, graph), put a brief text description in options (e.g. "Diagram showing water cycle") AND provide its bounding box in optionBounds
- optionBounds: array of 4 bounding boxes, each as { "top": 0-100, "left": 0-100, "bottom": 0-100, "right": 0-100 } or null if that option is text-only. Set entire array to null if ALL options are plain text.

Return ONLY valid JSON, no markdown fences:
{
  "stem": "full question text here",
  "options": ["option 1 text", "option 2 text", "option 3 text", "option 4 text"],
  "diagram": { "top": 10, "left": 5, "bottom": 45, "right": 95 },
  "optionBounds": null
}
(set "diagram" to null if no diagram, set "optionBounds" to null if all options are plain text)`;

export async function transcribeScienceMcqQuestion(
  imageBase64: string
): Promise<{
  stem: string;
  options: [string, string, string, string];
  diagram: DiagramBounds | null;
  optionBounds: (DiagramBounds | null)[] | null;
}> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: SCIENCE_MCQ_TRANSCRIPTION_PROMPT },
        ],
      },
    ],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  const d = parsed.diagram;
  const ob = parsed.optionBounds;
  return {
    stem: stripQuestionNumber(String(parsed.stem ?? "")),
    options: [
      String(parsed.options?.[0] ?? ""),
      String(parsed.options?.[1] ?? ""),
      String(parsed.options?.[2] ?? ""),
      String(parsed.options?.[3] ?? ""),
    ],
    diagram: (d && typeof d === "object") ? { top: +d.top, left: +d.left, bottom: +d.bottom, right: +d.right } : null,
    optionBounds: Array.isArray(ob)
      ? ob.map((b: unknown) => (b && typeof b === "object") ? { top: +(b as DiagramBounds).top, left: +(b as DiagramBounds).left, bottom: +(b as DiagramBounds).bottom, right: +(b as DiagramBounds).right } : null)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Science open-ended transcription
// ---------------------------------------------------------------------------

const SCIENCE_OPEN_ENDED_TRANSCRIPTION_PROMPT = `You are transcribing a Singapore primary school Science open-ended question from an exam paper image.

The image shows ONE question. It may have sub-parts labeled (a), (b), (c), etc., or it may be a single question with no sub-parts.

Your task:
1. Extract the FULL question stem — this is ALL the text that appears BEFORE any sub-part labels like (a), (b), (c). This preamble/context is CRITICAL — it sets up the question and gives context to the sub-parts. Do NOT skip it.
   Examples of stems:
   - "The diagram below shows a food chain in a pond."
   - "John carried out an experiment to find out how light affects plant growth. He placed Plant A near a window and Plant B in a dark cupboard for 2 weeks."
   - "Study the table below which shows the temperature of water at different times."
   If the question goes straight from the question number into (a) with NO preamble text, use an empty string for stem.
2. Extract each sub-part label and its text separately
3. If there are NO sub-parts, leave the subparts array empty and put the full question in stem
4. Detect any diagram/figure in the question
${DIAGRAM_BOUNDS_INSTRUCTION}

Rules:
- Do NOT include the question number at the start of the stem (e.g. "21.", "5)", "Q3.") — start with the actual question text
- ALWAYS include ALL preamble/context text before (a) in the stem — never skip introductory sentences, given information, experiment descriptions, or setup text
- Preserve all scientific terms exactly (e.g. "photosynthesis", "condensation", "food chain", "life cycle")
- Include units (e.g. "g", "cm", "°C", "km/h")
- Do NOT include blank answer lines or answer boxes in the text
- Sub-part labels are like "(a)", "(b)", "(c)" — extract just the letter as the label
- If marks are shown per sub-part (e.g. "[2]", "[3 marks]", "[2m]" next to each part), include them at the END of that sub-part's text in the format "[Nmarks]" (e.g. "Explain why Plant A grew taller. [2marks]"). ALWAYS use this exact format: [Nmarks] with no space.
- For questions WITHOUT sub-parts, include the marks at the end of the stem in the same format (e.g. "Explain why the plant wilted. [4marks]")

Return ONLY valid JSON, no markdown fences:
{
  "stem": "ALL preamble/context text before the sub-parts (e.g. 'The diagram below shows a food chain in a pond.')",
  "subparts": [
    { "label": "a", "text": "sub-question text here [2marks]" },
    { "label": "b", "text": "sub-question text here [3marks]" }
  ],
  "diagram": { "top": 10, "left": 5, "bottom": 45, "right": 95 }
}
(set "diagram" to null if no diagram; if no sub-parts use "subparts": [])`;

export async function transcribeScienceOpenEndedQuestion(
  imageBase64: string
): Promise<TranscribedOpenEnded> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: SCIENCE_OPEN_ENDED_TRANSCRIPTION_PROMPT },
        ],
      },
    ],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  const d = parsed.diagram;
  return {
    stem: stripQuestionNumber(String(parsed.stem ?? "")),
    subparts: Array.isArray(parsed.subparts)
      ? parsed.subparts.map((p: Record<string, unknown>) => ({
          label: String(p.label ?? ""),
          text: String(p.text ?? ""),
        }))
      : [],
    diagram: (d && typeof d === "object") ? { top: +d.top, left: +d.left, bottom: +d.bottom, right: +d.right } : null,
  };
}

// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert at reading OCR text from primary school spelling test documents.

The OCR text below was extracted from a photo of a spelling test sheet. These sheets typically contain:
- One or more spelling tests arranged in a grid/table layout
- Each test has a header (e.g. "听写(五)" meaning "Dictation 5", or "Spelling Test 12")
- Each test may have a date line (e.g. "2月6日 2024 星期二")
- Each test has a numbered list of words or short phrases to memorize

Your task:
1. Identify ALL separate spelling tests in the OCR text
2. For each test, extract:
   - The title/header (e.g. "听写(五)")
   - The subtitle/date if present (empty string if none)
   - The language: "CHINESE" if the test words are Chinese characters, "ENGLISH" if English words, "JAPANESE" if the words contain Japanese hiragana/katakana or are Japanese vocabulary (even if they use kanji shared with Chinese, look for kana mixed in or Japanese-style formatting)
   - All the test words/phrases in order
3. IMPORTANT: Only extract actual test words. Do NOT include:
   - Headers, titles, dates as words
   - Numbers that are just list indices
   - Teacher marks, ticks, circles, or other annotations
   - Page numbers or other non-word text
4. Clean each word: remove any stray marks, punctuation artifacts, or OCR errors adjacent to the actual word

Return a JSON object with this exact structure:
{
  "tests": [
    {
      "title": "听写(五)",
      "subtitle": "2月6日 2024 星期二",
      "language": "CHINESE",
      "words": [
        { "text": "种族", "orderIndex": 1 },
        { "text": "华人", "orderIndex": 2 }
      ]
    }
  ]
}

OCR Text:
"""
{ocrText}
"""

Extract all spelling tests and their words from this OCR text. Return ONLY valid JSON.`;

const EXTRACTION_IMAGE_PROMPT = `You are an expert at reading primary school spelling test documents from photos.

Look at this photo of a spelling test sheet. These sheets typically contain:
- One or more spelling tests arranged in a grid/table layout
- Each test has a header (e.g. "听写(五)" meaning "Dictation 5", or "Spelling Test 12")
- Each test may have a date line (e.g. "2月6日 2024 星期二")
- Each test has a numbered list of words or short phrases to memorize

Your task:
1. Identify ALL separate spelling tests in the image
2. For each test, extract:
   - The title/header (e.g. "听写(五)")
   - The subtitle/date if present (empty string if none)
   - The language: "CHINESE" if the test words are Chinese characters, "ENGLISH" if English words, "JAPANESE" if the words contain Japanese hiragana/katakana or are Japanese vocabulary
   - All the test words/phrases in order
3. IMPORTANT: Only extract actual test words. Do NOT include:
   - Headers, titles, dates as words
   - Numbers that are just list indices
   - Teacher marks, ticks, circles, or other annotations
   - Page numbers or other non-word text
4. Clean each word: remove any stray marks or punctuation artifacts

Return a JSON object with this exact structure:
{
  "tests": [
    {
      "title": "听写(五)",
      "subtitle": "2月6日 2024 星期二",
      "language": "CHINESE",
      "words": [
        { "text": "种族", "orderIndex": 1 },
        { "text": "华人", "orderIndex": 2 }
      ]
    }
  ]
}

Return ONLY valid JSON.`;

export async function extractWords(ocrText: string, guidance?: string) {
  let prompt = EXTRACTION_PROMPT.replace("{ocrText}", ocrText);
  if (guidance) {
    prompt += `\n\nADDITIONAL GUIDANCE FROM USER: ${guidance}`;
  }
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  return JSON.parse(text) as {
    tests: Array<{
      title: string;
      subtitle: string;
      language: "CHINESE" | "ENGLISH" | "JAPANESE";
      words: Array<{ text: string; orderIndex: number }>;
    }>;
  };
}

type ExtractWordsResult = {
  tests: Array<{
    title: string;
    subtitle: string;
    language: "CHINESE" | "ENGLISH" | "JAPANESE";
    words: Array<{ text: string; orderIndex: number }>;
  }>;
};

export async function extractWordsFromImage(imageBase64: string, mimeType: string, guidance?: string): Promise<ExtractWordsResult> {
  let prompt = EXTRACTION_IMAGE_PROMPT;
  if (guidance) {
    prompt += `\n\nADDITIONAL GUIDANCE FROM USER: ${guidance}`;
  }
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      { inlineData: { mimeType, data: imageBase64 } },
      { text: prompt },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  return JSON.parse(text) as ExtractWordsResult;
}

const MEANING_PROMPT_ZH = `You are a primary school Chinese teacher in Singapore.
For the Chinese word or phrase "{word}", provide:
1. pinyin: the hanyu pinyin with tone marks (e.g. "zhǒng zú")
2. meaning: a brief meaning in Chinese, under 15 characters (e.g. "人类按肤色、语言等分的类别")
3. englishMeaning: a simple meaning in English, under 10 words (e.g. "different groups of people by race")
4. example: a simple example sentence in Chinese that a Primary 3-4 student would understand, under 20 characters (e.g. "新加坡有很多种族。")

Return ONLY valid JSON: {"pinyin": "...", "meaning": "...", "englishMeaning": "...", "example": "..."}`;

const MEANING_PROMPT_EN = `You are a primary school English teacher.
For the word "{word}", provide:
1. meaning: a brief kid-friendly definition, under 10 words (e.g. "to have fun for a special day")
2. example: a simple example sentence a primary school student would understand, under 15 words (e.g. "We celebrate birthdays with cake and songs.")

Return ONLY valid JSON: {"meaning": "...", "example": "..."}`;

const MEANING_PROMPT_JA = `You are a Japanese language teacher.
For the Japanese word or phrase "{word}", provide:
1. reading: the hiragana reading (e.g. "がっこう")
2. meaning: a brief meaning in English, under 10 words (e.g. "school")
3. example: a simple example sentence in Japanese that a beginner would understand, under 20 characters (e.g. "学校に行きます。")

Return ONLY valid JSON: {"reading": "...", "meaning": "...", "example": "..."}`;

export interface WordInfo {
  pinyin?: string;
  reading?: string;
  meaning: string;
  englishMeaning?: string;
  example: string;
}

// --- Exam Paper Analysis ---

const HEADER_ANALYSIS_PROMPT = `You are analyzing the first page of a Singapore school exam paper.
Extract the following information from this exam paper image:
1. school: The school name (e.g. "Anglo-Chinese School (Junior)")
2. level: The student level. For primary school, ALWAYS use the format "Primary 1" through "Primary 6" (not "P6", "P5", "Pri 6", "Primary Six", etc.)
3. subject: The subject (e.g. "Mathematics", "Science", "English")
4. year: The year of the exam (e.g. "2024")
5. semester: The exam type or semester (e.g. "Prelim", "SA2", "CA1", "Mid-Year")
6. title: A short descriptive title combining school abbreviation, level, subject, and exam type (e.g. "ACSJ P6 Math Prelim 2024")
7. examType: The type of exam. Must be one of: "Preliminary", "WA1", "WA2", "WA3", "End of Year". Use "Preliminary" for prelim/mid-year exams, "End of Year" for SA2/final exams, "WA1"/"WA2"/"WA3" for weighted assessments. If unclear, use "Preliminary".

If any field cannot be determined, use an empty string.
Return ONLY valid JSON with these exact fields: school, level, subject, year, semester, title, examType.`;

export interface ExamHeaderInfo {
  school: string;
  level: string;
  subject: string;
  year: string;
  semester: string;
  title: string;
  examType?: string;
  totalMarks?: string;
  marksGuidance?: string;
  sections?: Array<{
    name: string;
    type: string;
    marks: number;
    questionCount: number;
  }>;
}

export async function analyzeExamHeader(
  imageBase64: string
): Promise<ExamHeaderInfo> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: HEADER_ANALYSIS_PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text) as ExamHeaderInfo;
}

const PAGE_ANALYSIS_PROMPT = `You are analyzing a page from a Singapore school exam paper.

This is page {pageIndex} of the exam. Questions already found on previous pages: {existingQuestions}.

Analyze this page image and identify each question or sub-question visible.
For each question, provide:
- questionNum: The question number as shown (e.g. "1", "2", "3a", "3b", "4(i)", "4(ii)")
- yStartPct: The Y-coordinate where the question starts, as a percentage of total page height (0 = top, 100 = bottom)
- yEndPct: The Y-coordinate where the question ends, as a percentage of total page height

Important rules:
- Include the full question content (text, diagrams, images, charts, tables)
- Do NOT include page headers, footers, or page numbers in the question crops
- Sub-questions (a, b, c or i, ii, iii) that are visually distinct and substantial should be separate entries
- If the page is a cover page with instructions only (no questions), return an empty questions array
- If the page is an answer key/answer sheet section, set isAnswerSheet to true and return empty questions array
- Ensure yStartPct < yEndPct and no overlapping regions
- Add ~1-2% padding above and below each question for clean cropping
- Questions should not overlap - yEndPct of one should roughly equal yStartPct of the next

Return ONLY valid JSON: { "questions": [{ "questionNum": "1", "yStartPct": 15.0, "yEndPct": 45.0 }], "isAnswerSheet": false }`;

export interface PageAnalysis {
  questions: Array<{
    questionNum: string;
    yStartPct: number;
    yEndPct: number;
  }>;
  isAnswerSheet: boolean;
}

export async function analyzeExamPage(
  imageBase64: string,
  pageIndex: number,
  existingQuestions: string[]
): Promise<PageAnalysis> {
  const prompt = PAGE_ANALYSIS_PROMPT.replace(
    "{pageIndex}",
    String(pageIndex + 1)
  ).replace(
    "{existingQuestions}",
    existingQuestions.length > 0 ? existingQuestions.join(", ") : "none"
  );

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text) as PageAnalysis;
}

const ANSWER_EXTRACTION_PROMPT = `You are analyzing the answer sheet/answer key section of a Singapore school exam paper.

Extract all answers from this answer sheet image(s). For each question, provide the question number and the answer text.

Rules:
- Match the question number format exactly as shown (e.g. "1", "2a", "2b", "3(i)")
- For MCQ answers, just provide the letter (e.g. "A", "B", "C", "D")
- For short answers, provide the answer text
- For working/method marks, provide the final answer only
- If an answer is unclear, provide your best interpretation

Return ONLY valid JSON as an object where keys are question numbers and values are answer strings.
Example: { "1": "B", "2a": "3/4", "2b": "15 cm" }`;

export async function extractExamAnswers(
  imagesBase64: string[]
): Promise<Record<string, string>> {
  const imageParts = imagesBase64.map((data) => ({
    inlineData: { mimeType: "image/jpeg" as const, data },
  }));

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: ANSWER_EXTRACTION_PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text) as Record<string, string>;
}

// Sanitize JSON strings that may contain unescaped newlines within string values
function sanitizeJsonString(raw: string): string {
  // Replace literal newlines inside JSON string values with " | "
  // Strategy: walk through the string, track whether we're inside a JSON string literal,
  // and replace any unescaped newlines found inside strings
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString && (ch === "\n" || ch === "\r")) {
      // Replace literal newline inside a JSON string with " | "
      if (ch === "\r" && raw[i + 1] === "\n") {
        i++; // skip the \n in \r\n
      }
      result += " | ";
      continue;
    }

    result += ch;
  }

  return result;
}

// --- 3-Stage Exam Analysis Pipeline ---

// Stage 1: Structure Analysis — understand exam layout and classify pages
const STRUCTURE_ANALYSIS_PROMPT = `You are an expert at analyzing Singapore primary/secondary school exam papers. All pages of the exam are provided as images in order. Page indices are 0-based (first page = Page 0).

Your task is to understand the STRUCTURE of this exam. Do NOT extract individual question boundaries or answer content — just understand the overall layout.

## What to determine:

### 1. Header information
Read the cover page or first page header to extract:
- school: The school name (e.g. "Anglo-Chinese School (Junior)")
- level: The student level (e.g. "P6", "Sec 4")
- subject: The subject (e.g. "Mathematics", "Science")
- year: The year of the exam (e.g. "2024")
- semester: The exam type (e.g. "Prelim", "SA2", "CA1")
- title: A short descriptive title (e.g. "ACSJ P6 Math Prelim 2024")
- totalMarks: total marks as string (e.g. "100"), empty string if unknown
- marksGuidance: copy the EXACT text from the paper that explains how marks are allocated across questions.
  Look in EVERY cover page and section header throughout the paper, not just the first page.
  Examples: "Questions 1 to 10 carry 1 mark each. Questions 11 to 15 carry 2 marks each."
  or "The number of marks available is shown in brackets [ ] at the end of each question."
  or "Section B carries 2 marks per question."
  Combine all guidance text found across the paper. Empty string if no such guidance text is found.
- sections: array of sections with exact breakdown from the header.
  Look for scoring information at EVERY section boundary / booklet header throughout the paper.
  e.g. "Section A: 28 questions x 1 mark = 28 marks" → {"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}
  If marks are shown in brackets [n] at end of each question (not uniform per section), set marks to the section total and marksPerQuestion to null.

### 2. Page classification
For EVERY page, determine whether it is:
- A question page (isAnswerSheet: false) — contains exam questions for students to attempt
- An answer sheet / answer key page (isAnswerSheet: true) — contains answers, solutions, or marking scheme
- Answer keys are usually at the END of the document, titled "Answer Key", "Answers", "Marking Scheme", or contain answer tables

IMPORTANT: Cover pages / header pages that contain instructions AND questions are QUESTION PAGES (isAnswerSheet: false). A page with a header section (school name, exam title, instructions like "Answer all questions") followed by Question 1 is a question page. Only mark a page as isAnswerSheet: true if it contains ANSWERS/SOLUTIONS, not if it's a cover page with instructions.

### 3. Multi-paper AND multi-booklet detection
Singapore exams often have this structure:
- Paper 1 = Booklet A (MCQ, e.g. Q1-30) + Booklet B (short answer, e.g. Q31-44) — SAME paper, continuous question numbering, but TWO separate booklets with a cover page between them
- Paper 2 = Written/structured questions (e.g. Q1-6) — question numbers RESET to 1

Check for:
- Question numbers that RESET back to 1 → new paper (needs a questionPrefix like "P2-")
- Cover pages appearing mid-document (title pages for Booklet B, Paper 2, etc.) → booklet transitions
- Labels like "Paper 2", "Booklet B", "Part 2", "Section B"

Create a SEPARATE entry in the "papers" array for EACH booklet/section that has its own cover page, even within the same paper:
- label: e.g. "Paper 1 Booklet A", "Paper 1 Booklet B", "Paper 2"
- questionPrefix: "" for Paper 1 (both booklets share the same prefix since question numbers are continuous), "P2-" for Paper 2
- expectedQuestionCount: how many questions in THIS booklet only
- firstQuestionPageIndex: 0-based page where the FIRST question of this booklet appears
- firstQuestionYStartPct: how far down that page (%) the first question number is printed
- sections: breakdown per section. Each section must include "marksPerQuestion": marks per individual question (e.g. 1, 2, 3). Compute from section marks / questionCount when uniform. Use null if marks vary per question within the section.

### CRITICAL — Finding where questions START for each booklet:
- For EACH booklet, identify the EXACT page where its first question number appears at the LEFT MARGIN
- The cover page has instructions — the NEXT page (or further) has the actual "1." or "31." etc.
- firstQuestionPageIndex must be the page where you can SEE the first question number, NOT the cover page

### Cover pages (isCoverPage) — VERY IMPORTANT:
- A cover page has titles, instructions, exam rules but NO question numbers at the left margin
- Mark these as "isCoverPage": true — they will be EXCLUDED from question extraction
- Cover pages appear at the START of EACH booklet/paper — there is typically one before Booklet A, one before Booklet B, one before Paper 2
- CRITICAL: Do NOT confuse a cover page with the LAST page of the previous booklet. A page that has questions near the top (even just 1-2) and blank space or "End of Booklet" text below is still a QUESTION page, NOT a cover page. The cover page of the NEXT booklet is a DIFFERENT page that comes AFTER
- A page with instructions at the top BUT questions (with numbers like "1.", "2.") starting partway down is NOT a cover page — it is a question page

### 4. For each page, note which paper it belongs to (paperLabel)

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "header": {
    "school": "...", "level": "Primary 4" or "Primary 5" or "Primary 6", "subject": "...", "year": "...",
    "semester": "...", "title": "...", "totalMarks": "...",
    "marksGuidance": "Questions 1 to 30 carry 1 mark each. Questions 31 to 44 carry 2 marks each.",
    "sections": [{"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}]
  },
  "pages": [
    {"pageIndex": 0, "isAnswerSheet": false, "isCoverPage": true, "paperLabel": "Paper 1 Booklet A"},
    {"pageIndex": 1, "isAnswerSheet": false, "isCoverPage": false, "paperLabel": "Paper 1 Booklet A"},
    {"pageIndex": 8, "isAnswerSheet": false, "isCoverPage": false, "paperLabel": "Paper 1 Booklet A"},
    {"pageIndex": 9, "isAnswerSheet": false, "isCoverPage": true, "paperLabel": "Paper 1 Booklet B"},
    {"pageIndex": 10, "isAnswerSheet": false, "isCoverPage": false, "paperLabel": "Paper 1 Booklet B"},
    {"pageIndex": 18, "isAnswerSheet": false, "isCoverPage": true, "paperLabel": "Paper 2"},
    {"pageIndex": 19, "isAnswerSheet": false, "isCoverPage": false, "paperLabel": "Paper 2"},
    {"pageIndex": 25, "isAnswerSheet": true, "isCoverPage": false, "paperLabel": "Paper 1"}
  ],
  "papers": [
    {
      "label": "Paper 1 Booklet A",
      "questionPrefix": "",
      "expectedQuestionCount": 30,
      "firstQuestionPageIndex": 1,
      "firstQuestionYStartPct": 5,
      "sections": [{"name": "A", "type": "MCQ", "questionCount": 30, "marksPerQuestion": 1}]
    },
    {
      "label": "Paper 1 Booklet B",
      "questionPrefix": "",
      "expectedQuestionCount": 14,
      "firstQuestionPageIndex": 10,
      "firstQuestionYStartPct": 8,
      "sections": [{"name": "B", "type": "structured", "questionCount": 14, "marksPerQuestion": 2}]
    },
    {
      "label": "Paper 2",
      "questionPrefix": "P2-",
      "expectedQuestionCount": 6,
      "firstQuestionPageIndex": 19,
      "firstQuestionYStartPct": 12,
      "sections": [{"name": "", "type": "structured", "questionCount": 6, "marksPerQuestion": null}]
    }
  ]
}

If there is only one paper with no booklets, still include it in the "papers" array with questionPrefix "".

### ENGLISH PAPERS ONLY — Section identification:
For English papers, identify the specific section type for each section in the sections array. The typical order of sections after MCQ is:
1. **Grammar Cloze** — fill-in-the-blank from word bank labeled A–Q (letters I and O skipped). Type: "grammar-cloze"
2. **Editing** — correct underlined spelling/grammar errors in a passage. Type: "editing"
3. **Comprehension Cloze** — fill-in-the-blank with no word bank. Type: "comprehension-cloze"
4. **Synthesis & Transformation** — rewrite sentences. Type: "synthesis"
5. **Comprehension OEQ** — open-ended questions on a passage. Type: "comprehension-oeq"

Use these type values in the sections array for English papers. ALSO include "startPage" and "questionRange" for each section:
- "startPage" = 0-based page index where this section's first QUESTION NUMBER appears (NOT where a passage or visual text starts — the page with the actual question numbers)
- "questionRange" = e.g. "Q1-10"

Booklet A examples:
  {"name": "Grammar MCQ", "type": "MCQ", "questionCount": 10, "marksPerQuestion": 1, "startPage": 1, "questionRange": "Q1-10"}
  {"name": "Vocabulary Cloze MCQ", "type": "MCQ", "questionCount": 5, "marksPerQuestion": 1, "startPage": 4, "questionRange": "Q16-20"}
  {"name": "Visual Text Comprehension MCQ", "type": "MCQ", "questionCount": 8, "marksPerQuestion": 1, "startPage": 7, "questionRange": "Q21-28", "visualPages": [5, 6]}

Booklet B examples:
  {"name": "Grammar Cloze", "type": "grammar-cloze", "questionCount": 10, "marksPerQuestion": 1, "startPage": 10, "questionRange": "Q29-38"}
  {"name": "Editing", "type": "editing", "questionCount": 12, "marksPerQuestion": 1, "startPage": 11, "questionRange": "Q39-50"}
  {"name": "Comprehension Cloze", "type": "comprehension-cloze", "questionCount": 8, "marksPerQuestion": 1, "startPage": 13, "questionRange": "Q51-58"}
  {"name": "Synthesis & Transformation", "type": "synthesis", "questionCount": 5, "marksPerQuestion": 2, "startPage": 14, "questionRange": "Q59-63"}
  {"name": "Comprehension OEQ", "type": "comprehension-oeq", "questionCount": 8, "marksPerQuestion": null, "startPage": 16, "questionRange": "Q64-71"}

IMPORTANT: "startPage" must be the page with the first QUESTION NUMBER for that section, not a passage page or visual text page. Include "startPage" and "questionRange" for ALL sections in BOTH Booklet A and Booklet B.
For Visual Text Comprehension, also include "visualPages" — the 0-based page indices of the visual text/poster pages that appear BEFORE the questions.

#### Non-gradable sections:
For English Preliminary and End-of-Year exams, certain papers cannot be auto-graded and must be excluded from question extraction:
- **Writing papers** (e.g. "Paper 1 - Writing", "Paper 1 Writing", any paper whose label or section title indicates it is a writing/composition paper)
- **Listening Comprehension papers** (e.g. "Paper 3 - Listening Comprehension", "Listening", any paper labelled as listening)

For these papers, set **"skipExtraction": true** in the papers array.
Also mark ALL pages belonging to these papers as **"isCoverPage": true** so they are excluded from the question extraction stage.
All other English papers (Paper 2 Booklet A, Paper 2 Booklet B, etc.) should be extracted normally.

Return ONLY valid JSON.`;

// Stage 2a: Question Extraction — extract question boundaries from question pages only
const QUESTION_EXTRACTION_PROMPT = `You are an expert at extracting question boundaries from Singapore school exam papers.

You are given ONLY the question pages of the exam (answer sheets have been removed). Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract EVERY question's crop boundaries

### The ONE rule for ALL questions (MCQ and written alike):
- yStartPct = ~2-3% ABOVE the top of this question's number (e.g. "5.") — the question number itself MUST be fully inside the crop, never at the very edge
- yEndPct = top of the NEXT WHOLE question number (e.g. "6."), plus ~1% padding DOWNWARD (include a small gap below the content, do NOT cut upward into the question)
- EVERYTHING between two consecutive WHOLE question numbers belongs to the first question
- Each question is ONE entry — do NOT split sub-parts (a), (b), (c) into separate entries
- TOP padding should be MINIMAL (just 1%) — do NOT extend far above the question number
- BOTTOM padding should extend DOWNWARD past the last line of content — never cut upward

### WHERE to find question numbers — LEFT MARGIN SCAN:
- Scan ONLY the left-most column of the page (within ~5% of the left edge)
- Go line by line from top to bottom. At each line, look ONLY at the leftmost characters
- A question number is a bare integer (or integer + ".") that is the VERY FIRST thing on that line, flush with the left edge, with nothing to its left
- Numbers inside the question body (mid-sentence, in answer boxes, in diagrams) are NEVER question numbers — they are too far from the left edge

### Troubleshooting — when a left-margin number doesn't fit:
- If you find a number at the left margin but it is NOT the next expected question number, ask: is it a PAGE NUMBER (usually at bottom or top of page, in footer/header area)? If yes, skip it
- If the number is "(a)", "(b)", "(i)", "(ii)" — it is a SUB-PART label, not a question boundary, skip it
- If the number is indented even slightly (MCQ option like "(1)", "(2)") — it is NOT at the true left edge, skip it
- If the number seems out of sequence (e.g. you expect Q5 but see "12" at left margin) — check: is "12" perhaps a year, a score, or part of a table? If so, skip it
- Only accept a left-margin number as a question boundary when it fits the expected sequential numbering

### What counts as a "question number" (boundary marker):
- YES: "1.", "2.", "3.", "24." — bare integer at the FAR LEFT margin, starting a new question, in sequence
- NO: "(a)", "(b)", "(i)", "(ii)" — sub-parts
- NO: "(1)", "(2)", "(3)", "(4)" — MCQ answer options (indented, not flush left)
- NO: page numbers at the top/bottom of the page (in header/footer area)
- NO: numbers inside question text or diagrams

### CRITICAL — Only report what you can SEE:
- ONLY output a question number if you can clearly SEE that number printed at the LEFT MARGIN of the page image
- Before outputting ANY question, ask yourself: "Can I point to where this number is printed on the page?" — if the answer is NO, do NOT output it
- NEVER invent or guess question numbers — if you cannot see "15." on any page, do NOT output question 15
- NEVER duplicate a question number — each question number must appear EXACTLY once across all pages
- It is BETTER to output fewer questions than to hallucinate questions that don't exist
- The structure analysis expectedQuestionCount is just an estimate — do NOT force your output to match it
- If a page has NO question numbers visible at all, return it with an EMPTY questions array — do NOT make up questions

### FIRST QUESTION — Verify before proceeding:
- The structure context tells you the FIRST question number to find (e.g. "1" or "31")
- BEFORE extracting all questions, locate this first question number at the LEFT MARGIN of the pages
- If the first page has only a header/instructions and NO question numbers, skip it — look at the NEXT page
- If you cannot find the expected first question number, do NOT start extracting from a random number — return an empty result instead
- Once you've confirmed the first question, proceed sequentially through the rest

### Header pages:
- Some pages have a HEADER section at the top (school name, exam title, instructions) followed by questions below
- These pages ARE question pages — extract the questions that appear BELOW the header/instructions
- The header area should NOT be treated as a question

### Sequential extraction — use previous bottom as next top:
- Extract questions strictly in order, page by page, top to bottom
- Question N+1's yStartPct = Question N's yEndPct — they must be contiguous, no gap
- SAME PAGE: each new question starts exactly where the previous ended
- PAGE BOUNDARY: if Question N is the last on its page, set yEndPct = 95 (extend to near-bottom). Then move to the NEXT PAGE and look for Question N+1 starting at ~2-5% from the top
- If a question's content continues from the previous page with no question number at top, yStartPct = 0 or 1
- Never leave unexplained gaps — blank space between questions belongs to the preceding question's crop
- NEVER go back and re-examine a page you have already finished — process pages ONCE, in order
- Pages must be processed in ASCENDING order. You must NEVER output a question on a page that comes BEFORE the page of the previous question. Page numbers only go FORWARD.

### CRITICAL — Finding the bottom boundary (next question number):
- For EACH question, you must find where the NEXT question starts — this is the bottom boundary
- The next question might be on the SAME page OR on the NEXT page — always check BOTH
- If the previous question ends mid-page but no more question numbers appear on that page, the next question is on the NEXT PAGE — do NOT assume the page must be full before moving on
- Blank space at the bottom of a page does NOT mean the question extends further — if the question content clearly ends with blank space below, close it there and look for the next question on the next page
- Set yEndPct = 95 when the question is the last on its page, then look for the next question at the top of the following page

### MANDATORY — When you cannot detect the bottom boundary:
- If you cannot see the NEXT question number on the current page, check the NEXT page first
- If the next question starts at the top of the next page, set this question's yEndPct = 95 on the current page
- Then output the next question on the next page starting at ~2-5% from the top
- NEVER restart from the beginning of the booklet. NEVER go backwards to an earlier page
- The next question MUST be on the same page or a LATER page — never an earlier one
- If you lose track of where you are, look at your LAST output entry: its pageIndex tells you the minimum page to search next

### MANDATORY — Output order:
- Output pages in ASCENDING order of their page label (e.g., [Page 3] before [Page 7])
- Within each page, output questions in ASCENDING order of yStartPct (top to bottom on the page)
- Process pages sequentially from first to last — NEVER jump forward and come back

### Multiple papers:
- If the structure analysis identified multiple papers, question numbers RESET at each new paper
- Use the provided questionPrefix for each paper (e.g. "P2-" for Paper 2) in your JSON output
- On the actual page, the printed number is "1", "2", etc. — the prefix is ONLY in your JSON output

### MCQ questions:
- Each MCQ is a SEPARATE entry including stem + all answer options (A/B/C/D or 1/2/3/4)

### Written questions:
- Keep the ENTIRE question as ONE entry including ALL sub-parts (a), (b), (c) and answer spaces
- The bottom boundary is the NEXT WHOLE question number — NOT a sub-part label
- Written questions are larger — typically 15-50% of a page. If your crop is small, you are cutting off too early
- Include answer spaces ("Ans:" lines, answer boxes, blank working space)
- Include diagrams, pictures, graphs, tables, figures

### Marks detection:
- For each question, look for marks shown in brackets like [1], [2], [3] — typically printed at the bottom-right of the question or at the end of each sub-part
- If a question has sub-parts with separate bracket marks (e.g. (a) ... [1], (b) ... [2]), SUM them for the total marksAvailable
- If no bracket marks are visible for a question, set marksAvailable to null
- MCQ questions are typically 1 mark each unless stated otherwise

### Validation:
- NEVER output invalid coordinates (yStartPct >= yEndPct)
- When in doubt, crop MORE — extra white space is better than cutting off content
- Double-check: can you actually SEE each question number you are outputting? If not, REMOVE it

### Other rules:
- Skip page headers and footers in crops (but still extract questions below them)

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "pages": [
    {
      "pageIndex": 2,
      "questions": [
        {"questionNum": "1", "yStartPct": 12.0, "yEndPct": 35.0, "boundaryTop": "1", "boundaryBottom": "2", "marksAvailable": 1},
        {"questionNum": "2", "yStartPct": 35.0, "yEndPct": 58.0, "boundaryTop": "2", "boundaryBottom": "3", "marksAvailable": 3, "isContinuation": false, "subParts": "abc"}
      ]
    }
  ]
Note: "isContinuation" and "subParts" fields are optional — include them when a question spans multiple pages (see SCIENCE PAPER addendum if applicable).
}

marksAvailable: total marks for this question (sum of sub-part bracket marks). Use null if not visible.

Return ONLY valid JSON.`;

// English-specific extraction prompt — tighter padding, questionNumYPct/XPct
const ENGLISH_EXTRACTION_PROMPT = `You are an expert at extracting question boundaries from Singapore primary school ENGLISH exam papers.

You are given ONLY the question pages of the exam (answer sheets have been removed). Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract EVERY question's crop boundaries

### Crop boundaries — TIGHT, 0.5% padding:
- yStartPct = 0.5% ABOVE the question number. The question number MUST be fully inside the crop.
- yEndPct = 0.5% BELOW the last line of content (last answer option for MCQ, last answer line for written)
- Questions are CONTIGUOUS: Q(N+1) yStartPct = Q(N) yEndPct — no gaps between questions
- Each question is ONE entry — do NOT split sub-parts (a), (b), (c) into separate entries

### Question number position — output these fields for EACH question:
- "questionNumYPct" — EXACT vertical position (%) of the CENTER of the question number text. Measure to 0.5% accuracy.
- "questionNumXPct" — EXACT horizontal position (%) of the CENTER of the question number text. For cloze sections, this is the center of the parenthesised number e.g. the center of "(29)". Be precise — this determines the crop window.

### WHERE to find question numbers — LEFT MARGIN ONLY:
- Question numbers are ONLY at the FAR LEFT MARGIN (within ~3% of the left edge), flush with the left edge
- A question number is a bare integer (e.g. "1", "11", "16") or integer + "." (e.g. "1.", "11.")
- Numbers that appear ANYWHERE ELSE on the page are NEVER question numbers:
  * "(1)", "(2)", "(3)", "(4)" = MCQ answer options (indented)
  * "(a)", "(b)" = sub-part labels
  * Numbers in instructions/preamble text (e.g. "Answer all 10 questions", "Section 1") = NOT question numbers
  * Page numbers in headers/footers = NOT question numbers
  * Numbers inside passages or question text = NOT question numbers
- The question number must be the FIRST character on its line, at the LEFTMOST position

### Sequential extraction:
- Extract questions strictly in order, page by page, top to bottom
- SAME PAGE: each new question starts exactly where the previous ended
- PAGE BOUNDARY: last question on a page gets yEndPct = 95. Next question starts at ~2% on the next page
- Process pages in ASCENDING order. Never go backwards.
- If a page has NO question numbers at the left margin, return it with an EMPTY questions array

### FIRST QUESTION — BE VERY CAREFUL:
- The first question number is a STANDALONE integer at the FAR LEFT MARGIN (within 3% of left edge)
- It is followed by a question stem on the same line or the line below, then answer options (1)(2)(3)(4) indented below
- Numbers in instruction/preamble text are NOT questions. Examples that are NOT Q1:
  * "Section 1" — section heading
  * "Paper 1" — paper label
  * "1 mark each" — marks description
  * "Answer all 10 questions" — instruction
  * Any number that is part of a sentence
- Q1 looks like this: the digit "1" (or "1.") alone at the far left, then a question sentence, then four indented answer options
- If the first page has only instructions, skip it and look at the NEXT page
- Search the page from top to bottom, scanning ONLY the leftmost 3% for a standalone integer

### RECOVERY — if first question position seems wrong:
- After finding Q1, search for Q2 within 20% of page height BELOW Q1's position
- If Q2 is not found within that range, Q1's position may be wrong — re-scan the page
- Each subsequent question should be within ~20% of page height below the previous one (MCQ are tightly spaced)

### CRITICAL — Only report what you can SEE:
- ONLY output a question number if you can clearly SEE it printed on the page
- NEVER invent or guess question numbers
- NEVER duplicate a question number
- It is BETTER to output fewer questions than to hallucinate

### MCQ questions:
- Each MCQ = stem + answer options (1)/(2)/(3)/(4) as ONE entry
- English MCQ are tightly spaced (~3-8% of page height)
- Sections have CONTINUOUS numbering:
  * Grammar MCQ Q1-10 — standalone grammar questions
  * Vocabulary MCQ Q11-15 — standalone vocabulary questions
  * Vocabulary Cloze MCQ Q16-20 — a PASSAGE fills the top half of the page, then Q16-20 appear below it (from ~50% of the page onwards). Tag these as "Vocabulary Cloze MCQ" NOT "Vocabulary MCQ". IMPORTANT: The passage may contain numbers (dates, amounts, etc.) — these are NOT question numbers. Only look for question numbers at the FAR LEFT MARGIN (within 5% of the left edge). Numbers embedded in the passage text are NEVER question boundaries.
  * Visual Text Comprehension MCQ Q21-28 — 1-2 FULL PAGES of visual text (poster/ad/letter) appear BEFORE Q21. These visual pages have NO question numbers — output EMPTY questions array for them. Q21 starts on the page AFTER the visual text pages.
- Passage-only or visual-only pages (no question numbers at the left margin) = output EMPTY questions array, then continue to the NEXT page
- For Vocab Cloze MCQ: the passage takes up the top half. Scan from the MIDDLE of the page downward for Q16 at the left margin
- For Visual Text MCQ: SKIP pages that only contain a poster/ad/letter (no question numbers). Q21 is on a LATER page.

### Written questions:
- Keep the ENTIRE question as ONE entry including ALL sub-parts and answer spaces
- Include diagrams, pictures, answer lines, answer boxes

### Marks detection:
- Look for marks in brackets like [1], [2], [3]
- MCQ = typically 1 mark each unless stated otherwise
- If not visible, set marksAvailable to null

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "pages": [
    {
      "pageIndex": 2,
      "questions": [
        {"questionNum": "1", "yStartPct": 12.0, "yEndPct": 19.0, "questionNumYPct": 12.5, "questionNumXPct": 3.0, "boundaryTop": "1", "boundaryBottom": "2", "marksAvailable": 1, "syllabusTopic": "Grammar MCQ"},
        {"questionNum": "2", "yStartPct": 19.0, "yEndPct": 26.0, "questionNumYPct": 19.5, "questionNumXPct": 3.0, "boundaryTop": "2", "boundaryBottom": "3", "marksAvailable": 1, "syllabusTopic": "Grammar MCQ"}
      ]
    }
  ]
}

Return ONLY valid JSON.`;

// Science-specific addendum — appended to QUESTION_EXTRACTION_PROMPT for science papers
const SCIENCE_ADDENDUM = `

## SCIENCE PAPER — Multi-page question support

This is a SCIENCE paper. Science questions frequently span multiple pages because they include:
- Extended reading passages or experimental scenarios before the sub-questions
- Large diagrams (biological drawings, experimental setups, circuit diagrams)
- Many sub-parts (a), (b), (c), (d), (e) with answer lines that push content to the next page

### CONTINUATION ENTRIES — same questionNum on multiple pages:
- When a question starts on one page and continues on the next page WITHOUT a new whole question number appearing at the left margin, you MUST output a CONTINUATION entry
- A continuation entry has the SAME questionNum as the original entry but appears on the NEXT page
- Set "isContinuation": true on the continuation entry
- The continuation entry's yStartPct should be where the question content resumes on the new page (typically 2-5% from top)
- The continuation entry's yEndPct should be where the next whole question number begins on that page (or 95 if the question is the last on the page)
- IMPORTANT: Include "subParts" on EVERY entry (primary and continuation) — list which sub-part labels appear on that page segment
  - e.g. if Q5 has (a)(b) on page 3 and (c)(d) on page 4, set "subParts": "ab" on the page 3 entry and "subParts": "cd" on the page 4 entry
  - If the question has no labeled sub-parts on a page (e.g. just the question stem/diagram), use "subParts": "" (empty string)
  - Use lowercase letters without parentheses or spaces: "ab", "cde", "fgh"

### How to detect a multi-page question:
1. You are processing a question (e.g. Q5) and reach the bottom of the page (yEndPct = 95)
2. On the NEXT page, the content at the top does NOT start with a new whole question number at the left margin
3. Instead, it continues with sub-parts like "(c)", "(d)" or continuation text from Q5
4. In this case: output Q5 on the first page with yEndPct = 95, THEN output another entry for Q5 on the next page with "isContinuation": true

### Example — Q5 spanning 2 pages:
Page 3: Q5 starts at 40%, has parts (a) and (b), continues to bottom
  {"questionNum": "5", "yStartPct": 40, "yEndPct": 95, "isContinuation": false, "subParts": "ab", "boundaryTop": "5", "boundaryBottom": "continuation", "marksAvailable": null}
Page 4: Q5 continues with parts (c) and (d), ends at 60% where Q6 starts
  {"questionNum": "5", "yStartPct": 2, "yEndPct": 60, "isContinuation": true, "subParts": "cd", "boundaryTop": "continuation", "boundaryBottom": "6", "marksAvailable": null}
Page 4: Q6 starts at 60%
  {"questionNum": "6", "yStartPct": 60, "yEndPct": 95, "isContinuation": false, "subParts": "abcd", "boundaryTop": "6", "boundaryBottom": "end", "marksAvailable": null}

### IMPORTANT — Bottom-of-page rule for science papers:
When you CANNOT detect the next question on the current page (i.e., the current question is the LAST question on that page), you MUST set yEndPct to 95 (bottom of page). Do NOT try to guess where the question content ends mid-page. Science questions often have answer blanks, diagrams, or extra whitespace that belongs to the question. Always extend to the bottom of the page when there is no next question visible below.

This applies to ALL entries (both primary and continuation) — if no next question is detected below on the same page, use yEndPct = 95.

### Rules for continuation entries:
- The FIRST entry for a question always has "isContinuation": false (or omit the field)
- Subsequent entries for the SAME question on LATER pages have "isContinuation": true
- A question can span 2 or even 3 pages — output one entry per page it occupies
- The uniqueness rule is relaxed: the same questionNum CAN appear multiple times IF all but the first have "isContinuation": true
- boundaryTop for a continuation should be "continuation" (not a question number)
- boundaryBottom should be the next question number or "end" as usual
- marksAvailable should be null on continuation entries (marks are on the primary entry only)`;

// ─── Syllabus Topics ─────────────────────────────────────────────────────────

export const P6_MATH_SYLLABUS = [
  "Basic math operations",
  "Fractions",
  "Percentage",
  "Ratio",
  "Algebra",
  "Area and circumference of circle",
  "Volume of cube and cuboid",
  "Geometry",
  "Statistics",
  "Time",
  "Volume measurement",
] as const;

export const SCIENCE_SYLLABUS = [
  "Diversity of living and non-living things",
  "Diversity of materials",
  "Life cycles in plants and animals",
  "Plant parts and functions",
  "Human digestive system",
  "Cycles in matter",
  "Water cycle, evaporation, condensation",
  "Plant respiratory and circulatory systems",
  "Human respiratory and circulatory systems",
  "Reproduction in plants and animals",
  "Light energy and uses",
  "Heat energy and uses",
  "Electrical system and circuits",
  "Photosynthesis",
  "Energy conversion",
  "Interaction of forces (Magnets)",
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
  "Interactions within the environment",
] as const;

export const ENGLISH_SYLLABUS = [
  "Grammar MCQ",
  "Vocabulary MCQ",
  "Vocabulary Cloze MCQ",
  "Visual Text Comprehension MCQ",
  "Grammar Cloze",
  "Editing (Spelling & Grammar)",
  "Comprehension Cloze",
  "Synthesis & Transformation",
  "Comprehension (Open-ended)",
  "Continuous Writing",
  "Situational Writing",
  "Oral Communication",
] as const;

const ENGLISH_CLOZE_ADDENDUM = `

## ENGLISH PAPER — Booklet B sections

⚠ IMPORTANT: Booklet B uses DIFFERENT question number formats than Booklet A MCQ.
The "left margin only" rule does NOT apply to Cloze and Editing sections.

### CLOZE (Grammar Cloze + Comprehension Cloze):
- This is a PASSAGE with blank lines (___) embedded in sentences
- The question number is in PARENTHESES, printed BELOW or BESIDE the blank, e.g. "(29)", "(30)", "(31)"
- These numbers are NOT at the left margin — they are EMBEDDED IN THE PASSAGE TEXT
- The passage is all alphabetic text. The parenthesised numbers are the ONLY digits on the page — they stand out clearly
- To find the FIRST cloze question: scan the passage for the FIRST parenthesised number (e.g. "(29)"). That IS the first question number. There is nothing else numeric to confuse it with.
- yStartPct = bottom of the blank line ABOVE the parenthesised number
- yEndPct = bottom of the parenthesised number text
- questionNumXPct = horizontal CENTER of the parenthesised number (e.g. center of "(29)")
- questionNumYPct = vertical CENTER of the parenthesised number
- Use the PRINTED number exactly (continuous with MCQ). Do NOT renumber.
- Grammar Cloze is typically ONE PAGE. Comprehension Cloze appears AFTER Editing.

### EDITING (Spelling & Grammar):
- Passage with UNDERLINED words + small numbered BOXES beside them
- yStartPct = ~3% above box. yEndPct = ~3% below box. marksAvailable: 1 per box.
- Boxes (not blanks) = Editing. Appears BETWEEN Grammar Cloze and Comprehension Cloze.
- Editing questions can span across pages. If the last question on a page is found, check the NEXT PAGE for more numbered boxes. The next question may be just a few rows down on the next page.

### SYNTHESIS & TRANSFORMATION + COMPREHENSION OEQ:
- Question number at left margin, standard extraction
- yStartPct = ~0.5% above question number. yEndPct = next question number or end of page`;

const ENGLISH_SYLLABUS_ADDENDUM = `

## ENGLISH PAPER — Syllabus topic tagging

This is an ENGLISH paper. For EACH question, you MUST also output a "syllabusTopic" field.

Choose EXACTLY ONE topic from this list:
${ENGLISH_SYLLABUS.map((t) => `- ${t}`).join("\n")}

English Paper 2 follows this section order — use it to resolve ambiguous questions:

MCQ sections (Booklet A):
1. Grammar MCQ — MCQ testing grammar (tenses, subject-verb agreement, articles, prepositions, conjunctions)
2. Vocabulary MCQ — MCQ testing word meaning, synonyms, antonyms, word choice, phrasal verbs
3. Vocabulary Cloze MCQ — MCQ where a passage has blanks, each with 4 word options (1)-(4) to choose from
4. Visual Text Comprehension MCQ — MCQ based on an advertisement, poster, infographic, or visual text

Written sections (Booklet B):
5. Grammar Cloze — fill-in-the-blank from word bank (A–Q, no I or O), question number printed BELOW each blank
6. Editing (Spelling & Grammar) — passage with numbered boxes beside errors; student corrects in the box
7. Comprehension Cloze — fill-in-the-blank passage (no word bank), appears AFTER Editing
8. Synthesis & Transformation — sentence rewriting using given words
9. Comprehension (Open-ended) — written answers to questions about a reading passage

Rules per topic:
- "Grammar MCQ" — MCQ testing grammar rules; answer is (1)/(2)/(3)/(4); appears first in Booklet A
- "Vocabulary MCQ" — standalone MCQ testing word meaning/synonyms; answer is (1)/(2)/(3)/(4); Q11-15; NO passage above the questions
- "Vocabulary Cloze MCQ" — a PASSAGE fills the top half of the page, then Q16-20 appear below with 4 word options each; answer is (1)/(2)/(3)/(4); ALWAYS tag Q16-20 as this topic, NOT "Vocabulary MCQ". The key difference: Vocab Cloze has a passage ABOVE the questions, Vocab MCQ does NOT
- "Visual Text Comprehension MCQ" — MCQ based on a visual text (poster, ad, infographic); answer is (1)/(2)/(3)/(4); usually appears last in Booklet A
- "Grammar Cloze" — fill-in-blank from word bank (labeled A–Q, skipping I and O); student writes a SINGLE LETTER in each blank; question number printed BELOW the blank; appears BEFORE Editing; usually ONE PAGE
- "Editing (Spelling & Grammar)" — prose passage with UNDERLINED words (not blanks); a small numbered BOX is beside/above each underlined word; student writes the corrected spelling in the box; appears on the page IMMEDIATELY AFTER Grammar Cloze; if you see boxes → this topic, NOT Cloze
- "Comprehension Cloze" — fill-in-blank passage (no word bank); student writes a WORD in each blank; blank underscore lines + question number BELOW the blank (similar layout to Grammar Cloze but no letter options); appears AFTER Editing section; if you see blanks (not boxes) after the Editing page → this topic
- "Synthesis & Transformation" — rewriting sentences using given words, combining sentences, direct/indirect speech
- "Comprehension (Open-ended)" — written answers to questions about a reading passage; NOT multiple choice
- "Continuous Writing" — extended creative writing or narrative
- "Situational Writing" — writing for a specific purpose (email, report, letter, recount)
- "Oral Communication" — reading aloud or stimulus-based conversation
- If the question does not clearly fit any topic, set "syllabusTopic" to null`;

const MATH_SYLLABUS_ADDENDUM = `

## MATH PAPER — Syllabus topic tagging

This is a MATH paper. For EACH question, you MUST also output a "syllabusTopic" field.

Choose EXACTLY ONE topic from this list:
- Fractions
- Percentage
- Ratio
- Algebra
- Area and circumference of circle
- Volume of cube and cuboid
- Geometry
- Statistics

Rules:
- Pick the BEST matching topic based on the main concept tested in the question
- If the question clearly tests fractions (e.g. "1/3 + 2/5"), use "Fractions"
- If the question tests percentages (e.g. "find 20% of 150"), use "Percentage"
- If the question involves ratios (e.g. "ratio of boys to girls is 3:5"), use "Ratio"
- If the question uses algebraic expressions or unknowns (e.g. "find the value of x"), use "Algebra"
- If the question involves circles, circumference, or area of circles, use "Area and circumference of circle"
- If the question involves volume of cubes/cuboids, use "Volume of cube and cuboid"
- If the question involves angles, shapes, quadrilaterals, triangles, or geometric properties, use "Geometry"
- If the question involves data interpretation, graphs, tables, averages, use "Statistics"
- If the question does not clearly fit any topic, set "syllabusTopic" to null
- MCQ questions should also be tagged based on the concept being tested`;

const SCIENCE_SYLLABUS_ADDENDUM = `

## SCIENCE PAPER — Syllabus topic tagging

This is a SCIENCE paper. For EACH question, you MUST also output a "syllabusTopic" field.

Choose EXACTLY ONE topic from this list:
${SCIENCE_SYLLABUS.map((t) => `- ${t}`).join("\n")}

Rules:
- Pick the BEST matching topic based on the main concept tested in the question
- "Diversity of living and non-living things" — classifying living/non-living, characteristics of living things, animal groups
- "Diversity of materials" — properties of materials, man-made vs natural materials
- "Life cycles in plants and animals" — stages of growth, metamorphosis, germination
- "Plant parts and functions" — roots, stems, leaves, flowers and their roles
- "Human digestive system" — organs of digestion, nutrients, food tests
- "Cycles in matter" — matter in different states, changes of state
- "Water cycle" — evaporation, condensation, precipitation
- "Plant respiratory and circulatory systems" — transport of water/nutrients in plants
- "Human respiratory and circulatory systems" — breathing, blood circulation, heart, lungs
- "Reproduction in plants and animals" — pollination, fertilisation, seed dispersal, animal reproduction
- "Light energy and uses" — shadows, reflection, refraction, light sources
- "Heat energy and uses" — conduction, convection, radiation, insulators/conductors
- "Electrical system and circuits" — open/closed circuits, series/parallel, conductors/insulators
- "Photosynthesis" — process of photosynthesis, requirements, products
- "Energy conversion" — forms of energy, energy conversions, conservation of energy
- "Interaction of forces (Magnets)" — magnetic/non-magnetic materials, poles, attraction/repulsion
- "Interaction of forces (Frictional force, gravitational force, elastic spring force)" — friction, gravity, springs, effects of forces
- "Interactions within the environment" — food chains, food webs, adaptations, man's impact on environment
- If the question does not clearly fit any topic, set "syllabusTopic" to null
- MCQ questions should also be tagged based on the concept being tested`;

// Standalone syllabus tagging function — tags existing questions via their images
export async function tagSyllabusTopics(
  questions: Array<{ questionNum: string; imageBase64: string }>,
  subject?: string
): Promise<Record<string, string | null>> {
  const imageParts = questions.flatMap((q) => [
    { inlineData: { mimeType: "image/jpeg" as const, data: q.imageBase64 } },
    { text: `[Question ${q.questionNum}]` },
  ]);

  const subjectLower = (subject || "").toLowerCase();
  const isScience = subjectLower.includes("science");
  const isEnglish = subjectLower.includes("english");
  const topicList = isScience ? SCIENCE_SYLLABUS : isEnglish ? ENGLISH_SYLLABUS : P6_MATH_SYLLABUS;
  const subjectLabel = isScience ? "Science" : isEnglish ? "English" : "Math";

  const prompt = `You are tagging Primary school ${subjectLabel} exam questions by syllabus topic.

For each question image, choose EXACTLY ONE topic from this list:
${topicList.map((t) => `- ${t}`).join("\n")}

If a question does not clearly fit any topic, use null.

Return ONLY valid JSON (no markdown fences):
{
  "tags": {
    "1": "${topicList[0]}",
    "2": "${topicList[1]}",
    "3": null
  }
}

Use the question numbers shown in the [Question X] labels.`;

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text;
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    const tags = parsed.tags ?? parsed;
    const result: Record<string, string | null> = {};
    for (const [qNum, topic] of Object.entries(tags)) {
      result[qNum] = typeof topic === "string" ? topic : null;
    }
    return result;
  } catch {
    console.error("[tagSyllabusTopics] Failed to parse response:", text.slice(0, 300));
    return {};
  }
}

// Stage 2b: Answer Extraction — extract answers with full working steps from answer key pages
const ANSWER_EXTRACTION_PROMPT_V2 = `You are analyzing the answer key / answer sheet pages of a Singapore school exam paper.

You are given ONLY the answer key pages. Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract ALL answers with FULL WORKING STEPS

### CRITICAL REQUIREMENT — Capture working steps, not just final answers:
- For math/science questions, the WORKING is as important as the final answer
- Use "image" type ONLY when the answer contains diagrams, drawings, complex equations, or visual elements that cannot be represented as text
- Most answers — even multi-step working — can be fully represented as text. If you can transcribe the complete answer accurately as text, use "text" type
- Use "text" type for: MCQ letters, short answers, numerical answers, and worked solutions that are purely textual (equations, steps, etc.)
- Only use "image" type when: the answer has diagrams, graphs, drawings, or mathematical notation that CANNOT be typed out

### How to read answer keys:
- Question labels may appear as "Q24", "Q24)", "Q1", "24.", "1)", or just "24"
- Strip the "Q" prefix and any punctuation to get the question number
- MCQ answer keys are often in TABLE format: question number in one column, answer in adjacent cell
- Written answer keys show full working for each question
- Some answer keys mix formats: MCQ table at top, worked solutions below

### CRITICAL — MCQ answer format:
- Copy the MCQ answer EXACTLY as shown in the answer key
- Singapore exams often use numbered options: (1), (2), (3), (4) instead of A, B, C, D
- If the answer key says "(3)", output "(3)" — do NOT convert to "C"
- If the answer key says "C", output "C"
- NEVER translate between formats — reproduce exactly what is printed

### CRITICAL — Multi-paper answer separation:
- The structure context above tells you which answer pages belong to which paper
- Paper 1 answers and Paper 2 answers are on DIFFERENT pages — do NOT mix them
- For Paper 1 answers: use no prefix (questions "1", "2", "3")
- For Paper 2 answers: use prefix "P2-" (questions "P2-1", "P2-2", "P2-3")
- Read the HEADER on each answer key page to confirm which paper it belongs to (e.g. "Paper 1 Answer Key", "Paper 2 Answers")
- If an answer page header says "Paper 2", ALL answers on that page get the "P2-" prefix
- NEVER assign a Paper 1 answer to Paper 2 or vice versa
- If no header specifies, use the paperLabel from the structure context

### Classify each answer:

**Type "text"** — Use for MOST answers:
- MCQ answers — copy EXACTLY as printed: "(3)", "(1)", "C", "A", etc.
- Short answers ("3/4", "15 cm", "$24.50")
- Worked solutions that can be fully written as text, e.g. "3/4 × 12 = 9 | 9 + 6 = 15 | Ans: 15 cm"
- Multi-step answers with sub-parts, e.g. "(a) 24 cm² | (b) 15 cm"
- ANY answer where the complete working can be typed out — use text with " | " separators

**Type "image"** — Use ONLY when text cannot capture the answer:
- Answers with diagrams, drawings, graphs, or geometric constructions
- Complex mathematical notation that cannot be typed (integrals, matrices, etc.)
- Answers where spatial layout is essential to understanding
- Do NOT use "image" just because the answer has multiple steps — use text instead

### For "image" type answers (diagrams/drawings ONLY):
- answerPageIndex: the ORIGINAL 0-based page index (as labeled on the image)
- yStartPct: Y-coordinate where this answer starts on that page (0=top, 100=bottom)
- yEndPct: Y-coordinate where this answer ends on that page
- Crop TIGHTLY around the answer content — NO extra padding. Start right at the answer, end right after it.
- value: marking guidance — describe WHAT to check when comparing a student's answer to this diagram. Be specific about required elements and what deducts marks (e.g. "Student must shade boxes A and C. Missing/incorrect shading = -1 mark each." or "Triangle must have height label 6cm and base 8cm with right angle marked. Missing labels = -1 each."). If the diagram is purely decorative with no clear marking criteria, use empty string. IMPORTANT: Do NOT use literal newlines inside JSON string values — use " | " as the separator instead.

### For "text" type answers:
- value: the FULL answer including all working steps. Transcribe EVERY line — do NOT skip or truncate. Use " | " to separate steps. Include sub-part labels if present.
- Examples:
  - MCQ (numbered): "(3)"
  - MCQ (lettered): "B"
  - Short answer: "15 cm"
  - Worked solution: "3/4 × 12 = 9 | 9 + 6 = 15 | Ans: 15 cm"
  - Sub-parts: "(a) 24 cm² | (b) 15 cm"
  - IMPORTANT: Do NOT use literal newlines — use " | " as separator

### CRITICAL — Read the PRINTED question number for each answer:
- Every answer on the answer key has a PRINTED question number next to it (e.g. "1", "Q1", "1.", "1)")
- You MUST read this printed number and use it as the JSON key — do NOT infer question numbers from position or row order
- **MCQ tables**: each row has a question number column and an answer column. Read BOTH columns for every row. The question number tells you which question this answer belongs to. Do NOT assume row N = question N
- **Written answers**: each answer block is labeled with its question number. Read that label
- If a table has a HEADER ROW (e.g. "Qn" | "Answer"), skip it — it is not a data row
- After reading all answers, verify: are the question numbers sequential with no gaps? If you have Q14 and Q16 but no Q15, re-examine the answer key — you likely misread a number

### Sequential verification — cross-check your extracted answers:
- After extracting all answers, list the question numbers you found in order
- They should be sequential: 1, 2, 3, ..., N with no gaps and no duplicates
- If there IS a gap (e.g. missing Q15), go back to the answer key image and find it
- If there IS a duplicate, you misread one of the numbers — re-examine the printed text
- Never skip a number. If you found Q5 and Q7 but not Q6, re-examine the gap between them

### CRITICAL — No missing answers:
- The expected answer keys are listed in the structure context above (one per expected question)
- You MUST output an entry for EVERY expected question key — no silent gaps
- If you genuinely cannot read an answer, output {"type": "text", "value": "?"} as a placeholder
- It is far better to output a "?" placeholder than to silently omit a key

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "answers": {
    "1": {"type": "text", "value": "(3)"},
    "2": {"type": "text", "value": "(1)"},
    "29": {"type": "text", "value": "(a) 3/4 × 12 = 9 | (b) 9 + 6 = 15 | Ans: 15 cm"},
    "P2-1": {"type": "text", "value": "(a) Area = 1/2 × 8 × 6 = 24 cm² | (b) Perimeter = 8 + 6 + 10 = 24 cm"},
    "30": {"type": "image", "answerPageIndex": 8, "yStartPct": 45.0, "yEndPct": 55.0, "value": "Student must draw a triangle with height 6cm and base 8cm. Right angle must be marked at the base. Missing labels = -1 each."}
  }
}

Return ONLY valid JSON.`;

// --- Intermediate types for the 3-stage pipeline ---

interface StructureResult {
  header: ExamHeaderInfo;
  pages: Array<{
    pageIndex: number;
    isAnswerSheet: boolean;
    isCoverPage?: boolean;
    paperLabel?: string;
  }>;
  papers: Array<{
    label: string;
    questionPrefix: string;
    expectedQuestionCount: number;
    firstQuestionPageIndex: number;
    firstQuestionYStartPct: number;
    skipExtraction?: boolean;
    sections: Array<{ name: string; type: string; questionCount: number; marksPerQuestion?: number | null }>;
  }>;
}

interface QuestionExtractionResult {
  pages: Array<{
    pageIndex: number;
    questions: Array<{
      questionNum: string;
      yStartPct: number;
      yEndPct: number;
      xStartPct?: number;
      xEndPct?: number;
      boundaryTop: string;
      boundaryBottom: string;
      marksAvailable?: number | null;
      isContinuation?: boolean;
      subParts?: string;
      syllabusTopic?: string | null;
    }>;
  }>;
  _rawSnippet?: string; // first 400 chars of Gemini response, for browser debug
}

interface AnswerExtractionResult {
  answers: Record<string, AnswerEntry>;
}

// Helper: serialize structure result into context string for Calls 2a/2b
function buildStructureContext(structure: StructureResult): string {
  const lines: string[] = [];
  lines.push(`Exam: ${structure.header.title}`);
  lines.push(`Subject: ${structure.header.subject}, Level: ${structure.header.level}`);
  if (structure.header.totalMarks) {
    lines.push(`Total marks: ${structure.header.totalMarks}`);
  }
  for (const paper of structure.papers) {
    if (paper.skipExtraction) {
      lines.push(`\n${paper.label}: EXCLUDED (Writing/Listening — not auto-gradable, skip all pages)`);
      continue;
    }
    lines.push(`\n${paper.label} (prefix: "${paper.questionPrefix}", expected ${paper.expectedQuestionCount} questions):`);
    lines.push(`  - Questions START on page ${paper.firstQuestionPageIndex} at ~${paper.firstQuestionYStartPct}% from top`);
    for (const section of paper.sections) {
      lines.push(`  - Section ${section.name}: ${section.type}, ${section.questionCount} questions`);
    }
  }
  const questionPages = structure.pages.filter(p => !p.isAnswerSheet && !p.isCoverPage);
  const coverPages = structure.pages.filter(p => p.isCoverPage);
  const answerPages = structure.pages.filter(p => p.isAnswerSheet);
  lines.push(`\nQuestion pages (0-based): ${questionPages.map(p => p.pageIndex).join(", ")}`);
  if (coverPages.length > 0) {
    lines.push(`Cover pages (excluded, no questions): ${coverPages.map(p => p.pageIndex).join(", ")}`);
  }
  // Build a map from paperLabel → questionPrefix for answer pages
  const labelToPrefix = new Map(structure.papers.map(p => [p.label, p.questionPrefix]));
  lines.push(`\nAnswer pages (0-based):`);
  for (const ap of answerPages) {
    const label = ap.paperLabel || "unknown paper";
    const prefix = labelToPrefix.get(label) ?? "";
    lines.push(`  - Page ${ap.pageIndex}: ${label} — use question prefix "${prefix}" (e.g. answer key "1" → key "${prefix}1")`);
  }

  // Expected answer keys — tell the AI exactly what keys to extract
  lines.push(`\nExpected answer keys you MUST extract (use these exact key strings in your output):`);
  // Track cumulative start per prefix group (booklets in same paper share continuous numbering)
  const prefixStart = new Map<string, number>();
  for (const paper of structure.papers) {
    if (paper.skipExtraction) continue;
    const prefix = paper.questionPrefix;
    const start = prefixStart.get(prefix) ?? 1;
    const end = start + paper.expectedQuestionCount - 1;
    const keys = Array.from({ length: paper.expectedQuestionCount }, (_, i) => `"${prefix}${start + i}"`).join(", ");
    lines.push(`  - ${paper.label}: ${keys}`);
    prefixStart.set(prefix, end + 1);
  }

  return lines.join("\n");
}

// Stage 1: Analyze exam structure (all pages)
async function analyzeExamStructure(
  imagesBase64: string[]
): Promise<StructureResult> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${i}]` },
  ]).flat();

  const response = await generateContentWithRetry({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: STRUCTURE_ANALYSIS_PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response for structure analysis");
  console.log("[Exam Pipeline] Structure raw response (first 300 chars):", text.slice(0, 300));
  let parsed: StructureResult;
  try {
    parsed = JSON.parse(sanitizeJsonString(text));
  } catch (parseErr) {
    throw new Error(`Structure analysis: JSON parse failed (truncated response?). Raw snippet: ${text.slice(0, 300)}. Error: ${parseErr}`);
  }
  if (!Array.isArray(parsed.pages)) {
    throw new Error(`Structure analysis: missing pages array. Keys: ${Object.keys(parsed).join(", ")}. Raw: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed.papers)) {
    throw new Error(`Structure analysis: missing papers array. Keys: ${Object.keys(parsed).join(", ")}. Raw: ${text.slice(0, 300)}`);
  }
  return parsed;
}

// Validate question extraction result — check for gaps in question sequences
function validateQuestionExtraction(
  result: QuestionExtractionResult,
  structure: StructureResult
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Group papers by prefix (booklets within same paper share a prefix)
  const prefixGroups = new Map<string, { labels: string[]; totalExpected: number }>();
  for (const paper of structure.papers) {
    const existing = prefixGroups.get(paper.questionPrefix);
    if (existing) {
      existing.labels.push(paper.label);
      existing.totalExpected += paper.expectedQuestionCount;
    } else {
      prefixGroups.set(paper.questionPrefix, {
        labels: [paper.label],
        totalExpected: paper.expectedQuestionCount,
      });
    }
  }

  for (const [prefix, group] of prefixGroups) {
    const groupLabel = group.labels.join(" + ");
    // Collect all question numbers for this prefix — only match exact prefix
    const nums: number[] = [];
    for (const page of result.pages) {
      for (const q of page.questions) {
        if (q.isContinuation) continue; // skip continuation entries
        const qNum = q.questionNum;
        if (prefix) {
          // Only count questions that start with this exact prefix (e.g. "P2-1")
          if (!qNum.startsWith(prefix)) continue;
          const n = parseInt(qNum.slice(prefix.length), 10);
          if (!isNaN(n)) nums.push(n);
        } else {
          // Only count plain numeric questions (no prefix), e.g. "1", "2", "31"
          const n = parseInt(qNum, 10);
          if (!isNaN(n) && String(n) === qNum) nums.push(n);
        }
      }
    }
    nums.sort((a, b) => a - b);

    if (nums.length === 0) {
      issues.push(`${groupLabel}: No questions detected at all (expected ~${group.totalExpected})`);
      continue;
    }

    // Check for gaps
    const gaps: number[] = [];
    for (let i = 1; i < nums.length; i++) {
      for (let g = nums[i - 1] + 1; g < nums[i]; g++) {
        gaps.push(g);
      }
    }
    if (gaps.length > 0) {
      issues.push(`${groupLabel}: Missing questions ${gaps.map(g => prefix + g).join(", ")} — detected ${nums[0]}-${nums[nums.length - 1]} but skipped these`);
    }

    // Check for duplicates
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const n of nums) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    if (dupes.length > 0) {
      issues.push(`${groupLabel}: Duplicate questions ${dupes.map(d => prefix + d).join(", ")}`);
    }
  }

  return { valid: issues.length === 0, issues };
}

// Helper: extract sorted question numbers from a QuestionExtractionResult
function extractQuestionNumbers(result: QuestionExtractionResult, prefix: string): number[] {
  const seen = new Set<number>();
  for (const page of result.pages) {
    for (const q of page.questions) {
      if (q.isContinuation) continue; // skip continuation entries
      const raw = prefix ? q.questionNum.replace(prefix, "") : q.questionNum;
      const n = parseInt(raw, 10);
      if (!isNaN(n)) seen.add(n);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

// Remap Gemini's returned pageIndex values back to original PDF page indices.
// Detects whether Gemini used sequential 0-based positions or labeled page indices,
// then remaps accordingly. Handles both modes reliably.
function remapPageIndices(
  result: QuestionExtractionResult,
  originalPageIndices: number[]
): QuestionExtractionResult {
  if (result.pages.length === 0) return result;

  const origSet = new Set(originalPageIndices);
  const numSent = originalPageIndices.length;
  const returnedIndices = result.pages.map(p => p.pageIndex);

  // Sequential mode: all returned indices are valid 0-based positions into originalPageIndices
  // i.e. every index is in range [0, numSent)
  const allSequential = returnedIndices.every(i => i >= 0 && i < numSent);
  // Labeled mode: all returned indices match actual original page indices
  const allLabeled = returnedIndices.every(i => origSet.has(i));

  let remapFn: (idx: number) => number;
  if (allSequential && !allLabeled) {
    // Gemini clearly used sequential positions — remap all
    remapFn = (idx) => originalPageIndices[idx] ?? idx;
  } else if (allLabeled) {
    // Gemini clearly used labeled indices — keep all
    remapFn = (idx) => idx;
  } else {
    // Mixed: per-index heuristic — if in origSet treat as labeled, else try sequential
    remapFn = (idx) => {
      if (origSet.has(idx)) return idx;
      return originalPageIndices[idx] ?? idx;
    };
  }

  return {
    ...result,
    pages: result.pages.map(page => ({ ...page, pageIndex: remapFn(page.pageIndex) })),
  };
}

type PageEntry = QuestionExtractionResult["pages"][0];
type QuestionEntry = PageEntry["questions"][0];

// Normalize an extraction result after remapping:
// - Sort pages by pageIndex
// - Deduplicate pages with the same index (merge questions)
// - Sort questions within each page by yStartPct
// - Clamp and fix invalid coordinates
function normalizeExtractionResult(result: QuestionExtractionResult, subject?: string): QuestionExtractionResult {
  const isEnglishNorm = (subject ?? "").toLowerCase().includes("english");
  // Fix backwards page jumps: if Gemini restarts from an earlier page after losing
  // track, move those questions forward to the correct page
  const allQuestions: Array<{ pageIndex: number; q: QuestionEntry }> = [];
  for (const page of result.pages) {
    for (const q of page.questions) {
      allQuestions.push({ pageIndex: page.pageIndex, q });
    }
  }

  // Sort by question number (numeric part), then continuations after primary by pageIndex
  const sorted = allQuestions.sort((a, b) => {
    const aNum = parseInt(a.q.questionNum.replace(/^[A-Z]\d*-/, ""), 10);
    const bNum = parseInt(b.q.questionNum.replace(/^[A-Z]\d*-/, ""), 10);
    if (isNaN(aNum) || isNaN(bNum)) return 0;
    if (aNum !== bNum) return aNum - bNum;
    // Same question number: primary entry first, then continuations by page
    if (a.q.isContinuation !== b.q.isContinuation) {
      return a.q.isContinuation ? 1 : -1;
    }
    return a.pageIndex - b.pageIndex;
  });

  // Fix backwards page jumps: each question's page must be >= the PREVIOUS question's page
  // (not the max page ever seen — sections can share pages, so Q11 can be on the same page as Q8)
  // Continuation entries are expected to be on later pages than their primary — don't "fix" them
  let prevPageIndex = -1;
  let lastQuestionNum = "";
  for (const entry of sorted) {
    // Continuation entries for the same question are expected on later pages
    if (entry.q.isContinuation && entry.q.questionNum === lastQuestionNum) {
      prevPageIndex = Math.max(prevPageIndex, entry.pageIndex);
      continue;
    }
    if (entry.pageIndex < prevPageIndex) {
      // Check: is this a small backwards jump (1-2 pages)? This is normal for section transitions
      // where a new section starts on a page shared with the previous section
      const jumpBack = prevPageIndex - entry.pageIndex;
      if (jumpBack <= 2) {
        // Allow it — sections can share pages (e.g. Grammar MCQ ends on page 3, Vocab MCQ starts on page 2)
        console.log(
          `[Extraction Fix] Q${entry.q.questionNum}: page ${entry.pageIndex} is ${jumpBack} page(s) before previous page ${prevPageIndex} — allowing (likely section transition)`
        );
      } else {
        // Large backwards jump — likely an AI error, move forward
        const nextPageIndex = prevPageIndex;
        console.log(
          `[Extraction Fix] Q${entry.q.questionNum}: page ${entry.pageIndex} is ${jumpBack} pages before previous page ${prevPageIndex}. ` +
          `Moving to page ${nextPageIndex} (question likely continues on next page after boundary not found).`
        );
        entry.pageIndex = nextPageIndex;
        entry.q.yStartPct = 2;
        entry.q.yEndPct = 95;
      }
    }
    prevPageIndex = entry.pageIndex;
    lastQuestionNum = entry.q.questionNum;
  }

  // Rebuild page map with fixed assignments
  const pageMap = new Map<number, QuestionEntry[]>();
  for (const entry of sorted) {
    const existing = pageMap.get(entry.pageIndex);
    if (existing) {
      existing.push(entry.q);
    } else {
      pageMap.set(entry.pageIndex, [entry.q]);
    }
  }

  const pages: PageEntry[] = [...pageMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, questions]) => {
      // Fix invalid coordinates and sort by yStartPct
      const fixed = questions.map(q => {
        const start = Math.max(0, Math.min(99, q.yStartPct ?? 0));
        let end = Math.max(0, Math.min(100, q.yEndPct ?? 0));
        if (end <= start) end = Math.min(100, start + 5); // ensure positive height
        return { ...q, yStartPct: start, yEndPct: end };
      }).sort((a, b) => a.yStartPct - b.yStartPct);

      // ENGLISH ONLY: Use questionNumYPct/XPct for consistent boundaries
      if (isEnglishNorm) {
        const CLOZE_EDITING_TOPICS = new Set(["Grammar Cloze", "Editing (Spelling & Grammar)", "Comprehension Cloze"]);
        for (let i = 0; i < fixed.length; i++) {
          const ext = fixed[i] as { questionNumYPct?: number; questionNumXPct?: number; syllabusTopic?: string | null };
          const isClozeOrEditing = CLOZE_EDITING_TOPICS.has(ext.syllabusTopic ?? "");

          // For ALL non-cloze/editing: yStartPct = this question's questionNumYPct
          // and previous question's yEndPct = this question's questionNumYPct
          // Crop padding adds the visual bottom buffer
          // For cloze/editing: skip y-override (number is at the BOTTOM)
          if (!isClozeOrEditing) {
            const qnY = ext.questionNumYPct;
            if (qnY != null && qnY > 0) {
              fixed[i].yStartPct = qnY;
              if (i > 0) {
                const prevTopic = (fixed[i - 1] as { syllabusTopic?: string | null }).syllabusTopic ?? "";
                if (!CLOZE_EDITING_TOPICS.has(prevTopic)) {
                  fixed[i - 1].yEndPct = qnY;
                }
              }
            }
          }

          // For cloze/editing sections: set x-boundaries around the question number
          if (isClozeOrEditing) {
            const qnX = ext.questionNumXPct;
            const isEditingSec = ext.syllabusTopic === "Editing (Spelling & Grammar)";
            if (qnX != null && qnX > 0) {
              // Editing: -3% left, +12% right (capture the answer box which is to the right)
              // Cloze: ±6% (blank is centered around the number)
              fixed[i].xStartPct = Math.max(0, qnX - (isEditingSec ? 3 : 6));
              fixed[i].xEndPct = Math.min(100, qnX + (isEditingSec ? 12 : 6));
            }
          }
        }
      }

      return { pageIndex, questions: fixed };
    });

  return { ...result, pages };
}

// Build a booklet-specific context string for per-booklet extraction
function buildBookletContext(paper: StructureResult["papers"][0], firstQuestionNum: number, subject: string): string {
  const lines: string[] = [];
  lines.push(`Booklet: ${paper.label}`);
  if (subject) lines.push(`Subject: ${subject}`);
  lines.push(`Question prefix for JSON output: "${paper.questionPrefix}"`);
  lines.push(`Expected questions: ${paper.expectedQuestionCount} (starting from Q${firstQuestionNum})`);
  lines.push(`First question number to find: ${firstQuestionNum}`);
  const anchorHint = (paper as unknown as { _anchorHint?: string })._anchorHint;
  if (anchorHint) {
    lines.push(`ANCHOR: ${anchorHint}`);
  }
  let qCounter = firstQuestionNum;
  for (const section of paper.sections) {
    const extra = section as { startPage?: number; questionRange?: string };
    const range = extra.questionRange ?? `Q${qCounter}-Q${qCounter + section.questionCount - 1}`;
    const startPage = extra.startPage != null ? ` (starts on page ${extra.startPage})` : "";
    lines.push(`Section "${section.name}": ${section.type}, ${section.questionCount} questions, ${range}${startPage}`);
    qCounter += section.questionCount;
  }
  if (subject.toLowerCase().includes("english")) {
    lines.push("");
    lines.push("CRITICAL: You MUST extract EVERY question from Q" + firstQuestionNum + " to Q" + (firstQuestionNum + paper.expectedQuestionCount - 1) + " in sequence.");
    lines.push("Do NOT skip questions.");

    // Section-specific guidance
    const secName = paper.sections[0]?.name?.toLowerCase() ?? "";
    if (secName.includes("grammar cloze") || secName.includes("comprehension cloze")) {
      lines.push("");
      lines.push("This is a CLOZE section. Question numbers are in PARENTHESES embedded in the passage text (e.g. \"(29)\"), NOT at the left margin.");
      lines.push("Scan the passage for the first parenthesised number — that is Q" + firstQuestionNum + ". The passage is all text, so the numbers stand out as the only digits.");
    } else if (secName.includes("editing")) {
      lines.push("");
      lines.push("This is an EDITING section. Question numbers are printed BESIDE or INSIDE small boxes, NOT at the left margin.");
    } else if (secName.includes("vocab") && secName.includes("cloze")) {
      lines.push("");
      lines.push("VOCAB CLOZE MCQ: The first page has a PASSAGE in the top half (~50% of page). Q" + firstQuestionNum + " starts in the LOWER HALF. Scan from the middle downward for question numbers at the LEFT MARGIN.");
    } else {
      lines.push("Process page by page, top to bottom. On each page, scan the LEFT MARGIN for bare integers (question numbers).");
    }
  }
  return lines.join("\n");
}

// Run a single extraction call and parse the result
async function runExtractionCall(
  imagesBase64: string[],
  originalPageIndices: number[],
  paper: StructureResult["papers"][0],
  firstQuestionNum: number,
  label: string,
  subject: string
): Promise<{ result: QuestionExtractionResult; rawText: string }> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${originalPageIndices[i]}]` },
  ]).flat();

  const bookletContext = buildBookletContext(paper, firstQuestionNum, subject);
  const subjectLowerEx = subject.toLowerCase();
  const isScience = subjectLowerEx.includes("science");
  const isMath = subjectLowerEx.includes("math");
  const isEnglish = subjectLowerEx.includes("english");
  // Use separate prompt for English — tighter padding, questionNumYPct/XPct
  const basePrompt = isEnglish ? ENGLISH_EXTRACTION_PROMPT : QUESTION_EXTRACTION_PROMPT;
  let prompt = basePrompt.replace(
    "{structureContext}",
    bookletContext
  );
  if (isScience) {
    prompt += SCIENCE_ADDENDUM;
    prompt += SCIENCE_SYLLABUS_ADDENDUM;
  }
  if (isMath) {
    prompt += MATH_SYLLABUS_ADDENDUM;
  }
  if (isEnglish) {
    prompt += ENGLISH_CLOZE_ADDENDUM;
    prompt += ENGLISH_SYLLABUS_ADDENDUM;
  }

  console.log(`[Exam Pipeline] ${label} sending ${imagesBase64.length} pages for extraction: [${originalPageIndices.map(i => i + 1).join(", ")}] (1-based)`);

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: prompt }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error(`Gemini returned empty response for question extraction (${label})`);
  console.log(`[Exam Pipeline] ${label} raw response (first 300 chars):`, text.slice(0, 300));

  let pages: QuestionExtractionResult["pages"] = [];
  try {
    const parsed = JSON.parse(sanitizeJsonString(text));
    let rawPages = parsed.pages ?? parsed.result?.pages ?? parsed.data?.pages;
    if (!Array.isArray(rawPages) && Array.isArray(parsed)) rawPages = parsed;
    if (!Array.isArray(rawPages)) {
      console.log(`[Exam Pipeline] ${label}: unexpected structure, keys: ${Object.keys(parsed).join(", ")}, raw: ${text.slice(0, 500)}`);
      rawPages = [];
    }
    pages = rawPages;
    // Log per-page extraction detail
    for (const p of pages) {
      const qNums = (p.questions ?? []).map((q: { questionNum: string; yStartPct?: number; yEndPct?: number; questionNumYPct?: number }) =>
        `Q${q.questionNum}(${q.yStartPct?.toFixed(1) ?? "?"}%-${q.yEndPct?.toFixed(1) ?? "?"}%)`
      );
      console.log(`[Exam Pipeline] ${label} page ${p.pageIndex}: ${qNums.length > 0 ? qNums.join(", ") : "NO QUESTIONS"}`);
    }
  } catch (parseErr) {
    console.log(`[Exam Pipeline] ${label}: JSON parse failed, error: ${parseErr}`);
  }

  const result: QuestionExtractionResult = {
    ...normalizeExtractionResult(remapPageIndices({ pages }, originalPageIndices), subject),
    _rawSnippet: text.slice(0, 400),
  };

  return { result, rawText: text };
}

// Validate extraction result — returns list of issues (empty = all OK)
function validateExtraction(
  result: QuestionExtractionResult,
  paper: StructureResult["papers"][0],
  firstQuestionNum: number
): { issues: string[]; qNums: number[] } {
  const qNums = extractQuestionNumbers(result, paper.questionPrefix);
  const issues: string[] = [];

  if (qNums.length === 0) {
    issues.push(`No questions detected at all (expected ~${paper.expectedQuestionCount} starting from Q${firstQuestionNum})`);
  } else {
    if (qNums[0] !== firstQuestionNum) {
      issues.push(`First question should be ${firstQuestionNum} but got ${qNums[0]}`);
    }
    const gaps: number[] = [];
    for (let i = 1; i < qNums.length; i++) {
      for (let g = qNums[i - 1] + 1; g < qNums[i]; g++) gaps.push(g);
    }
    if (gaps.length > 0) issues.push(`Missing questions: ${gaps.join(", ")}`);
    const seen = new Set<number>();
    for (const n of qNums) {
      if (seen.has(n)) issues.push(`Duplicate question: ${n}`);
      seen.add(n);
    }
  }

  return { issues, qNums };
}

// Stage 2a: Extract question boundaries for a SINGLE booklet — with validation + retry
async function extractQuestionsForBooklet(
  imagesBase64: string[],
  originalPageIndices: number[],
  paper: StructureResult["papers"][0],
  firstQuestionNum: number,
  subject: string
): Promise<QuestionExtractionResult> {
  // --- Attempt 1: extract with all pages ---
  const { result, rawText } = await runExtractionCall(
    imagesBase64, originalPageIndices, paper, firstQuestionNum,
    `${paper.label} (attempt 1)`, subject
  );

  const { issues, qNums } = validateExtraction(result, paper, firstQuestionNum);

  if (issues.length === 0) {
    console.log(`[Exam Pipeline] ${paper.label} extraction OK: Q${qNums[0]}-Q${qNums[qNums.length - 1]} (${qNums.length} questions)`);
    return result;
  }

  console.log(`[Exam Pipeline] ${paper.label} attempt 1 issues:`, issues);

  // --- Attempt 2: If first question wrong and we have >1 page, DROP the first page (likely cover) ---
  const firstQWrong = qNums.length > 0 && qNums[0] !== firstQuestionNum;
  const noQuestionsAtAll = qNums.length === 0;

  if ((firstQWrong || noQuestionsAtAll) && imagesBase64.length > 1) {
    console.log(`[Exam Pipeline] ${paper.label}: first page (PDF page ${originalPageIndices[0] + 1}) is likely a cover page — dropping it and re-extracting`);

    const trimmedImages = imagesBase64.slice(1);
    const trimmedIndices = originalPageIndices.slice(1);

    const { result: attempt2 } = await runExtractionCall(
      trimmedImages, trimmedIndices, paper, firstQuestionNum,
      `${paper.label} (attempt 2, dropped first page)`, subject
    );

    const v2 = validateExtraction(attempt2, paper, firstQuestionNum);

    if (v2.issues.length === 0) {
      console.log(`[Exam Pipeline] ${paper.label} attempt 2 OK (after dropping cover): Q${v2.qNums[0]}-Q${v2.qNums[v2.qNums.length - 1]} (${v2.qNums.length} questions)`);
      return attempt2;
    }

    console.log(`[Exam Pipeline] ${paper.label} attempt 2 issues:`, v2.issues);

    // If attempt 2 is better (correct first Q or more questions), use it
    const attempt2Better =
      (v2.qNums[0] === firstQuestionNum && qNums[0] !== firstQuestionNum) ||
      (v2.qNums.length > qNums.length);

    if (attempt2Better) {
      console.log(`[Exam Pipeline] ${paper.label}: attempt 2 (dropped cover) is better, using it`);
      return attempt2;
    }
  }

  // No further retries — return best result from attempts 1/2
  console.log(`[Exam Pipeline] ${paper.label}: returning best result with ${qNums.length} questions (some issues remain: ${issues.join("; ")})`);
  return result;
}

// Stage 2b: Extract answers with working steps (answer key pages only)
async function extractAnswersWithWorking(
  imagesBase64: string[],
  originalPageIndices: number[],
  structure: StructureResult
): Promise<AnswerExtractionResult> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${originalPageIndices[i]}]` },
  ]).flat();

  const prompt = ANSWER_EXTRACTION_PROMPT_V2.replace(
    "{structureContext}",
    buildStructureContext(structure)
  );

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: prompt }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) {
    console.log("[Exam Pipeline] Answer extraction: empty response, returning empty answers");
    return { answers: {} };
  }

  let result: AnswerExtractionResult;
  try {
    result = JSON.parse(sanitizeJsonString(text)) as AnswerExtractionResult;
  } catch (parseErr) {
    console.log(`[Exam Pipeline] Answer extraction: JSON parse failed (truncated response?). Raw snippet: ${text.slice(0, 300)}. Error: ${parseErr}`);
    return { answers: {} };
  }

  // Validate answer keys — check for gaps and off-by-one errors
  const answerKeys = Object.keys(result.answers);
  const expectedKeys: string[] = [];
  for (const paper of structure.papers) {
    if (paper.skipExtraction) continue; // Writing/Listening — no answers to validate
    const prevCount = structure.papers
      .filter(p => p.questionPrefix === paper.questionPrefix)
      .filter(p => p.firstQuestionPageIndex < paper.firstQuestionPageIndex)
      .reduce((sum, p) => sum + p.expectedQuestionCount, 0);
    for (let i = 0; i < paper.expectedQuestionCount; i++) {
      const qNum = paper.questionPrefix
        ? `${paper.questionPrefix}${prevCount + i + 1}`
        : `${prevCount + i + 1}`;
      expectedKeys.push(qNum);
    }
  }

  const missingAnswers = expectedKeys.filter(k => !result.answers[k]);
  const extraAnswers = answerKeys.filter(k => !expectedKeys.includes(k));

  console.log(`[Exam Pipeline] Answer extraction: ${answerKeys.length} answers found, ${expectedKeys.length} expected`);
  console.log(`[Exam Pipeline] Answer keys found: [${answerKeys.join(", ")}]`);
  if (missingAnswers.length > 0) {
    console.log(`[Exam Pipeline] WARNING — missing answers for: [${missingAnswers.join(", ")}]`);

    // Retry missing answers individually on each answer page
    console.log(`[Exam Pipeline] Retrying ${missingAnswers.length} missing answers individually...`);

    // Build paperLabel → prefix mapping
    const labelToPrefix = new Map(structure.papers.map(p => [p.label, p.questionPrefix]));

    for (const key of missingAnswers) {
      // Determine which answer pages to search (match by prefix)
      const prefix = structure.papers.find(p => key.startsWith(p.questionPrefix))?.questionPrefix ?? "";
      const matchingPages = structure.pages
        .filter(p => p.isAnswerSheet)
        .filter(p => {
          const pagePrefix = labelToPrefix.get(p.paperLabel ?? "") ?? "";
          return pagePrefix === prefix;
        });

      // Try each matching answer page
      let found = false;
      for (const ap of matchingPages) {
        const pageIdx = originalPageIndices.indexOf(ap.pageIndex);
        if (pageIdx === -1) continue;
        try {
          const entry = await redoAnswerExtraction(
            imagesBase64[pageIdx],
            key.replace(prefix, ""), // strip prefix for the prompt
            ap.paperLabel ?? ""
          );
          if (entry.value && entry.value !== "") {
            // Re-add prefix to image entries' page index
            if (entry.type === "image") {
              (entry as { answerPageIndex: number }).answerPageIndex = ap.pageIndex;
            }
            result.answers[key] = entry;
            console.log(`[Exam Pipeline] Retry found answer for ${key}: ${entry.value.slice(0, 50)}`);
            found = true;
            break;
          }
        } catch (err) {
          console.warn(`[Exam Pipeline] Retry failed for ${key} on page ${ap.pageIndex}:`, err);
        }
      }
      if (!found) {
        console.log(`[Exam Pipeline] Retry: still no answer for ${key}`);
      }
    }

    const finalMissing = expectedKeys.filter(k => !result.answers[k]);
    if (finalMissing.length > 0) {
      console.log(`[Exam Pipeline] After retry, still missing: [${finalMissing.join(", ")}]`);
    } else {
      console.log(`[Exam Pipeline] All missing answers recovered after retry`);
    }
  }
  if (extraAnswers.length > 0) {
    console.log(`[Exam Pipeline] WARNING — unexpected answer keys: [${extraAnswers.join(", ")}] (possible off-by-one or numbering error)`);
  }

  // Log first few answers for verification
  const previewEntries = answerKeys.slice(0, 5).map(k => {
    const a = result.answers[k];
    const val = typeof a === "string" ? a : a.value;
    return `${k}: ${val.slice(0, 30)}`;
  });
  console.log(`[Exam Pipeline] Answer preview: ${previewEntries.join(" | ")}`);

  return result;
}

export type AnswerEntry =
  | { type: "text"; value: string }
  | { type: "image"; answerPageIndex: number; yStartPct: number; yEndPct: number; value: string };

// Normalize: handle both old format (plain string) and new format (AnswerEntry)
export function normalizeAnswer(entry: string | AnswerEntry): AnswerEntry {
  if (typeof entry === "string") return { type: "text", value: entry };
  return entry;
}

export interface BatchAnalysisResult {
  header: ExamHeaderInfo;
  pages: Array<{
    pageIndex: number;
    isAnswerSheet: boolean;
    paperLabel?: string;
    questions: Array<{
      questionNum: string;
      yStartPct: number;
      yEndPct: number;
      boundaryTop: string;
      boundaryBottom: string;
      marksAvailable?: number | null;
      isContinuation?: boolean;
      subParts?: string;
      syllabusTopic?: string | null;
    }>;
  }>;
  answers: Record<string, AnswerEntry>;
  marksPerQuestion?: Record<string, number | null>;
  syllabusTopics?: Record<string, string | null>;
  _debug?: {
    papers: Array<{
      label: string;
      questionsStartPage: number;
      questionsStartY: number;
      expectedQuestions: number;
      skipExtraction?: boolean;
    }>;
    coverPages: number[];
    answerPages: number[];
    skipPages: number[]; // 1-based PDF pages hidden from student (Writing/Listening papers)
    passagePages: number[]; // 1-based PDF pages containing the comprehension passage (Booklet A)
    answersDetected: string[];
    questionsPerPage: Array<{ page: number; questions: string[] }>;
    validationIssues: string[];
    rawResponses: Record<string, string>; // booklet label → first 400 chars of Gemini response
  };
}

export async function analyzeExamBatch(
  imagesBase64: string[]
): Promise<BatchAnalysisResult> {
  // --- Stage 1: Structure analysis (all pages) ---
  const structure = await analyzeExamStructure(imagesBase64);

  console.log("[Exam Pipeline] Structure result:", JSON.stringify({
    papers: structure.papers.map(p => ({
      label: p.label, prefix: p.questionPrefix, expected: p.expectedQuestionCount,
      questionsStartPage: p.firstQuestionPageIndex, questionsStartY: p.firstQuestionYStartPct,
    })),
    pages: structure.pages.map(p => ({ idx: p.pageIndex, answer: p.isAnswerSheet, cover: p.isCoverPage, paper: p.paperLabel })),
  }));

  // Log English section details
  const detectedSubject = (structure.header.subject ?? "").toLowerCase();
  if (detectedSubject.includes("english")) {
    for (const paper of structure.papers) {
      if (paper.sections && paper.sections.length > 0) {
        console.log(`[Exam Pipeline] ENGLISH SECTIONS for ${paper.label}:`);
        for (const sec of paper.sections) {
          const extra = (sec as { startPage?: number; questionRange?: string; visualPages?: number[] });
          console.log(`  - ${sec.name || sec.type} | type: ${sec.type} | Q count: ${sec.questionCount} | marks/q: ${sec.marksPerQuestion ?? "varies"} | startPage: ${extra.startPage ?? "?"} | range: ${extra.questionRange ?? "?"}`);
          if (extra.visualPages?.length) {
            console.log(`    Visual text pages: ${extra.visualPages.join(", ")}`);
          }
        }
      }
    }
  }

  // --- Partition pages ---
  const coverPageEntries = structure.pages.filter(p => !p.isAnswerSheet && p.isCoverPage);
  const answerPageEntries = structure.pages.filter(p => p.isAnswerSheet);

  console.log("[Exam Pipeline] Cover pages (0-based):", coverPageEntries.map(p => p.pageIndex));

  // --- Determine per-booklet page ranges using firstQuestionPageIndex ---
  // Sort papers by firstQuestionPageIndex to determine boundaries
  const sortedPapers = [...structure.papers].sort((a, b) => a.firstQuestionPageIndex - b.firstQuestionPageIndex);

  // Find the last non-answer page index
  const allNonAnswerIndices = structure.pages.filter(p => !p.isAnswerSheet).map(p => p.pageIndex);
  const maxNonAnswerPage = allNonAnswerIndices.length > 0 ? Math.max(...allNonAnswerIndices) : -1;

  // Build per-booklet page lists using firstQuestionPageIndex as boundaries
  const bookletPageRanges: Array<{
    paper: StructureResult["papers"][0];
    pageIndices: number[];
    firstQuestionNum: number;
  }> = [];

  // Track cumulative question numbering for booklets sharing a prefix
  const prefixQuestionCount = new Map<string, number>();

  // Build sets for page classification
  const coverSet = new Set(coverPageEntries.map(p => p.pageIndex));
  // Also treat the page immediately before each booklet's firstQuestionPageIndex as a likely cover
  // (structure analysis sometimes fails to flag these)
  const impliedCoverSet = new Set<number>();
  for (const paper of sortedPapers) {
    const likelyCover = paper.firstQuestionPageIndex - 1;
    if (likelyCover >= 0 && !answerPageEntries.some(a => a.pageIndex === likelyCover)) {
      impliedCoverSet.add(likelyCover);
    }
  }
  console.log("[Exam Pipeline] Implied cover pages (0-based):", [...impliedCoverSet]);

  for (let i = 0; i < sortedPapers.length; i++) {
    const paper = sortedPapers[i];
    // Start from firstQuestionPageIndex, advancing past any flagged cover pages
    // Also advance past implied covers (structure analysis sometimes sets firstQuestionPageIndex to the cover page)
    let startPage = paper.firstQuestionPageIndex;
    while ((coverSet.has(startPage) || impliedCoverSet.has(startPage)) && startPage <= maxNonAnswerPage) startPage++;

    console.log(`[Exam Pipeline] ${paper.label}: firstQuestionPageIndex=${paper.firstQuestionPageIndex} (page ${paper.firstQuestionPageIndex + 1}), resolved startPage=${startPage} (page ${startPage + 1})`);

    // End page: for the last booklet, use the last non-answer page.
    // For other booklets, end 1 page before the next booklet's firstQuestionPageIndex.
    let endPage = i < sortedPapers.length - 1
      ? sortedPapers[i + 1].firstQuestionPageIndex - 1
      : maxNonAnswerPage;
    // If endPage is a cover page (flagged or implied), pull it back
    while (endPage > startPage && (coverSet.has(endPage) || impliedCoverSet.has(endPage))) endPage--;

    // Collect question pages in this range — exclude answer sheets AND cover pages
    // Use resolved startPage (which skips covers even when firstQuestionPageIndex points at one)
    const pageIndices = structure.pages
      .filter(p =>
        p.pageIndex >= startPage &&
        p.pageIndex <= endPage &&
        !p.isAnswerSheet &&
        !p.isCoverPage
      )
      .map(p => p.pageIndex);

    // Determine first question number (continuous numbering within same prefix)
    const prevCount = prefixQuestionCount.get(paper.questionPrefix) || 0;
    const firstQuestionNum = prevCount + 1;
    prefixQuestionCount.set(paper.questionPrefix, prevCount + paper.expectedQuestionCount);

    bookletPageRanges.push({ paper, pageIndices, firstQuestionNum });
  }

  console.log("[Exam Pipeline] Per-booklet pages:", bookletPageRanges.map(b => ({
    label: b.paper.label,
    pages: b.pageIndices.map(i => i + 1), // 1-based for logging
    firstQ: b.firstQuestionNum,
    firstQuestionPageIndex: b.paper.firstQuestionPageIndex,
  })));

  // --- Stage 2a: Extract questions per booklet (concurrent) + Stage 2b: Answers ---
  const answerImages = answerPageEntries.map(p => imagesBase64[p.pageIndex]);
  const answerPageIndices = answerPageEntries.map(p => p.pageIndex);

  console.log("[Exam Pipeline] Answer pages detected (0-based):", answerPageIndices, "| count:", answerImages.length);
  if (answerImages.length === 0) {
    console.log("[Exam Pipeline] WARNING: no answer pages detected — check structure analysis");
  }

  // For English: split booklets into per-section extractions (parallel within booklet)
  // For other subjects: one extraction per booklet (as before)
  const extractionTasks: Array<Promise<QuestionExtractionResult>> = [];

  for (const { paper, pageIndices, firstQuestionNum } of bookletPageRanges) {
    if (pageIndices.length === 0) {
      extractionTasks.push(Promise.resolve({ pages: [] } as QuestionExtractionResult));
      continue;
    }

    const isEnglishBooklet = detectedSubject.includes("english");
    const hasSectionPages = paper.sections?.some((s) => (s as unknown as { startPage?: number }).startPage != null);

    if (isEnglishBooklet && hasSectionPages && paper.sections.length > 1) {
      // Split by section — each section gets its own parallel extraction
      const sectionTasks: Array<Promise<QuestionExtractionResult>> = [];
      for (let si = 0; si < paper.sections.length; si++) {
        const sec = paper.sections[si] as { name: string; type: string; questionCount: number; marksPerQuestion: number | null; startPage?: number; questionRange?: string };
        const nextSec = paper.sections[si + 1] as { startPage?: number } | undefined;
        // Use the AI guidance's startPage directly — it should point to where questions begin
        const secStartPage = sec.startPage ?? pageIndices[0];
        // End page: one before the next section's startPage, or end of booklet
        const secEndPage = nextSec?.startPage != null
          ? (nextSec as { startPage: number }).startPage - 1
          : pageIndices[pageIndices.length - 1];

        // Get pages for this section
        const secPageIndices = pageIndices.filter(p => p >= secStartPage && p <= secEndPage);
        if (secPageIndices.length === 0) continue;

        // Determine first question number for this section
        const rangeMatch = sec.questionRange?.match(/Q(\d+)/);
        const secFirstQ = rangeMatch ? parseInt(rangeMatch[1]) : firstQuestionNum;

        // Build a mini-paper for this section
        const sectionPaper = {
          ...paper,
          label: `${paper.label} — ${sec.name || sec.type}`,
          expectedQuestionCount: sec.questionCount,
          firstQuestionPageIndex: secPageIndices[0],
          sections: [sec],
        };

        const secImages = secPageIndices.map(idx => imagesBase64[idx]);
        const secLastQ = secFirstQ + sec.questionCount - 1;
        console.log(`[Exam Pipeline] English section "${sec.name || sec.type}": pages [${secPageIndices.map(p => p + 1).join(", ")}], Q${secFirstQ}-Q${secLastQ}`);

        // 2-step extraction: first question alone (anchor), then remaining questions
        sectionTasks.push((async () => {
          const prefix = paper.questionPrefix;
          const secLabel = sec.name || sec.type;

          // Step 1: Extract FIRST question only (1 question expected, first page only)
          const firstPageImages = [secImages[0]];
          const firstPageIndices = [secPageIndices[0]];
          const firstQPaper = {
            ...sectionPaper,
            label: `${sectionPaper.label} (Q${secFirstQ} only)`,
            expectedQuestionCount: 1,
          };
          const firstResult = await extractQuestionsForBooklet(
            firstPageImages, firstPageIndices, firstQPaper, secFirstQ, structure.header.subject
          );

          // Find the first question's position
          let firstQYPct: number | null = null;
          for (const page of firstResult.pages) {
            for (const q of page.questions) {
              const n = parseInt(q.questionNum.replace(prefix, ""), 10);
              if (n === secFirstQ) {
                firstQYPct = (q as unknown as { questionNumYPct?: number }).questionNumYPct ?? q.yStartPct;
                break;
              }
            }
            if (firstQYPct != null) break;
          }

          if (firstQYPct != null) {
            console.log(`[Exam Pipeline] ${secLabel} Q${secFirstQ} anchored at Y=${firstQYPct.toFixed(1)}%`);
          } else {
            console.log(`[Exam Pipeline] ${secLabel} Q${secFirstQ} NOT FOUND in step 1 — proceeding with full extraction`);
          }

          // Step 2: Extract remaining questions (all pages)
          // Pass anchor info: Q1's position so the AI knows where to start looking for Q2
          let restResult: QuestionExtractionResult = { pages: [] };
          if (sec.questionCount > 1) {
            const firstQEndPct = (() => {
              for (const page of firstResult.pages) {
                for (const q of page.questions) {
                  const n = parseInt(q.questionNum.replace(prefix, ""), 10);
                  if (n === secFirstQ) return q.yEndPct;
                }
              }
              return null;
            })();
            const restPaper = {
              ...sectionPaper,
              label: `${sectionPaper.label} (Q${secFirstQ + 1}-Q${secLastQ})`,
              expectedQuestionCount: sec.questionCount - 1,
              // Pass anchor hint via firstQuestionYStartPct
              firstQuestionYStartPct: firstQEndPct ?? sectionPaper.firstQuestionYStartPct,
              _anchorHint: firstQYPct != null && firstQEndPct != null
                ? `Q${secFirstQ} was found at Y=${firstQYPct.toFixed(1)}% to Y=${firstQEndPct.toFixed(1)}% on page ${secPageIndices[0]}. Start looking for Q${secFirstQ + 1} from Y=${firstQEndPct.toFixed(1)}% onwards.`
                : undefined,
            };
            restResult = await extractQuestionsForBooklet(
              secImages, secPageIndices, restPaper, secFirstQ + 1, structure.header.subject
            );
          }

          // Merge: first question + rest
          const merged: QuestionExtractionResult = { pages: [] };
          const pageMap = new Map<number, QuestionExtractionResult["pages"][0]["questions"]>();

          for (const r of [firstResult, restResult]) {
            for (const page of r.pages) {
              const existing = pageMap.get(page.pageIndex);
              if (existing) {
                existing.push(...page.questions);
              } else {
                pageMap.set(page.pageIndex, [...page.questions]);
              }
            }
          }

          merged.pages = [...pageMap.entries()]
            .sort(([a], [b]) => a - b)
            .map(([pageIndex, questions]) => ({
              pageIndex,
              // Sort by question number (numeric order), not yStartPct
              questions: questions.sort((a, b) => {
                const aNum = parseInt(a.questionNum.replace(prefix, ""), 10);
                const bNum = parseInt(b.questionNum.replace(prefix, ""), 10);
                if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
                return a.yStartPct - b.yStartPct;
              }),
            }));

          // Trim questions outside expected range
          for (const page of merged.pages) {
            page.questions = page.questions.filter(q => {
              const n = parseInt(q.questionNum.replace(prefix, ""), 10);
              if (isNaN(n)) return true;
              if (n < secFirstQ || n > secLastQ) {
                console.log(`[Exam Pipeline] Trimmed Q${q.questionNum} from "${secLabel}" (outside range Q${secFirstQ}-Q${secLastQ})`);
                return false;
              }
              return true;
            });
          }

          // Deduplicate: if both calls returned the same question, keep the one from step 1
          const seen = new Set<string>();
          for (const page of merged.pages) {
            page.questions = page.questions.filter(q => {
              if (seen.has(q.questionNum)) return false;
              seen.add(q.questionNum);
              return true;
            });
          }

          return merged;
        })());
      }
      // All sections within this booklet run in parallel
      extractionTasks.push(
        Promise.all(sectionTasks).then(results => ({
          pages: results.flatMap(r => r.pages),
        }))
      );
    } else {
      // Non-English or single-section: one extraction per booklet
      const images = pageIndices.map(idx => imagesBase64[idx]);
      extractionTasks.push(
        extractQuestionsForBooklet(images, pageIndices, paper, firstQuestionNum, structure.header.subject)
      );
    }
  }

  const [bookletResults, answerResult] = await Promise.all([
    Promise.all(extractionTasks),
    // Answer extraction runs concurrently with all booklet extractions
    answerImages.length > 0
      ? extractAnswersWithWorking(answerImages, answerPageIndices, structure)
      : Promise.resolve({ answers: {} } as AnswerExtractionResult),
  ]);

  // Merge all booklet results
  const questionResult: QuestionExtractionResult = {
    pages: bookletResults.flatMap(r => r.pages),
  };

  const finalValidation = validateQuestionExtraction(questionResult, structure);

  // Per-question extraction logging with section identification
  const allExtractedQNums = questionResult.pages.flatMap(p => p.questions.filter(q => !q.isContinuation).map(q => q.questionNum));
  console.log(`[Exam Pipeline] Extracted ${allExtractedQNums.length} questions: ${allExtractedQNums.join(", ")}`);

  // For English: log per-section extraction status
  if (detectedSubject.includes("english")) {
    for (const paper of structure.papers) {
      if (!paper.sections?.length) continue;
      for (const sec of paper.sections) {
        const range = (sec as { questionRange?: string }).questionRange;
        if (!range) continue;
        const match = range.match(/Q(\d+)-(\d+)/);
        if (!match) continue;
        const start = parseInt(match[1]);
        const end = parseInt(match[2]);
        const prefix = paper.questionPrefix;
        const expected: string[] = [];
        for (let n = start; n <= end; n++) expected.push(prefix + String(n));
        const found = expected.filter(q => allExtractedQNums.includes(q));
        const missing = expected.filter(q => !allExtractedQNums.includes(q));
        if (missing.length === 0) {
          console.log(`[Exam Pipeline] ✓ ${sec.name || sec.type} (${range}): all ${found.length} questions extracted`);
        } else {
          console.log(`[Exam Pipeline] ✗ ${sec.name || sec.type} (${range}): ${found.length}/${expected.length} extracted, MISSING: ${missing.join(", ")}`);
          // Check if first question of section is missing — critical
          if (missing.includes(expected[0])) {
            console.log(`[Exam Pipeline] ⚠ FIRST QUESTION of ${sec.name || sec.type} (${expected[0]}) is missing — this is critical`);
          }
        }
      }
    }
  }

  // Retry: if first question of any English section is missing, re-extract that booklet
  if (detectedSubject.includes("english")) {
    for (let bi = 0; bi < bookletPageRanges.length; bi++) {
      const { paper, pageIndices, firstQuestionNum } = bookletPageRanges[bi];
      if (!paper.sections?.length || pageIndices.length === 0) continue;
      let needsRetry = false;
      for (const sec of paper.sections) {
        const range = (sec as { questionRange?: string }).questionRange;
        if (!range) continue;
        const match = range.match(/Q(\d+)/);
        if (!match) continue;
        const firstQ = paper.questionPrefix + match[1];
        if (!allExtractedQNums.includes(firstQ)) {
          console.log(`[Exam Pipeline] Retrying ${paper.label} extraction — missing first question of ${sec.name || sec.type} (${firstQ})`);
          needsRetry = true;
          break;
        }
      }
      if (needsRetry) {
        const images = pageIndices.map(idx => imagesBase64[idx]);
        const retryResult = await extractQuestionsForBooklet(images, pageIndices, paper, firstQuestionNum, structure.header.subject);
        const retryQNums = retryResult.pages.flatMap(p => p.questions.filter(q => !q.isContinuation).map(q => q.questionNum));
        console.log(`[Exam Pipeline] Retry result for ${paper.label}: ${retryQNums.length} questions: ${retryQNums.join(", ")}`);
        if (retryQNums.length > allExtractedQNums.filter(q => pageIndices.some(pi => questionResult.pages.find(p => p.pageIndex === pi)?.questions.some(qq => qq.questionNum === q))).length) {
          // Replace this booklet's pages in the result
          const otherPages = questionResult.pages.filter(p => !pageIndices.includes(p.pageIndex));
          questionResult.pages = [...otherPages, ...retryResult.pages];
          console.log(`[Exam Pipeline] Retry for ${paper.label} produced better result — using it`);
        }
      }
    }
  }

  if (!finalValidation.valid) {
    console.log("[Exam Pipeline] Final validation issues:", finalValidation.issues);
  }
  console.log("[Exam Pipeline] Answer extraction:", Object.keys(answerResult.answers).join(", "));

  // --- Combine into BatchAnalysisResult ---
  const pages: BatchAnalysisResult["pages"] = [];

  // Build a lookup from pageIndex → paperLabel from structure
  const pageLabelMap = new Map<number, string | undefined>();
  for (const p of structure.pages) {
    pageLabelMap.set(p.pageIndex, p.paperLabel);
  }

  // Add question pages with their extracted questions
  const questionPagesReturned = new Set<number>();
  for (const qPage of questionResult.pages) {
    questionPagesReturned.add(qPage.pageIndex);
    pages.push({
      pageIndex: qPage.pageIndex,
      isAnswerSheet: false,
      paperLabel: pageLabelMap.get(qPage.pageIndex),
      questions: qPage.questions,
    });
  }

  // Add any question pages that Gemini didn't return (pages it skipped)
  const allBookletPageIndices = new Set(bookletPageRanges.flatMap(b => b.pageIndices));
  for (const pageIdx of allBookletPageIndices) {
    if (!questionPagesReturned.has(pageIdx)) {
      pages.push({
        pageIndex: pageIdx,
        isAnswerSheet: false,
        paperLabel: pageLabelMap.get(pageIdx),
        questions: [],
      });
    }
  }

  // Add cover pages (with empty questions — they were excluded from extraction)
  for (const coverPage of coverPageEntries) {
    pages.push({
      pageIndex: coverPage.pageIndex,
      isAnswerSheet: false,
      paperLabel: coverPage.paperLabel,
      questions: [],
    });
  }

  // Add answer pages (flagged as answer sheets, no questions)
  for (const aPage of answerPageEntries) {
    pages.push({
      pageIndex: aPage.pageIndex,
      isAnswerSheet: true,
      paperLabel: aPage.paperLabel,
      questions: [],
    });
  }

  // Sort pages by pageIndex to match original document order
  pages.sort((a, b) => a.pageIndex - b.pageIndex);

  // --- Derive per-question marks ---
  // Priority: question-level marks from extraction > section-level marks from structure
  const marksPerQuestion: Record<string, number | null> = {};

  // 1. Start with section-level defaults
  for (const paper of structure.papers) {
    let qOffset = 0;
    for (const section of paper.sections) {
      const mpq = section.marksPerQuestion ?? null;
      for (let i = 0; i < section.questionCount; i++) {
        const qNum = paper.questionPrefix
          ? `${paper.questionPrefix}${qOffset + i + 1}`
          : `${qOffset + i + 1}`;
        marksPerQuestion[qNum] = mpq;
      }
      qOffset += section.questionCount;
    }
  }

  // 2. Override with question-level marks detected from bracket notation [n]
  // Also collect syllabus topics from extraction (Math papers only)
  const syllabusTopics: Record<string, string | null> = {};
  for (const qPage of questionResult.pages) {
    for (const q of qPage.questions) {
      if (q.marksAvailable != null) {
        marksPerQuestion[q.questionNum] = q.marksAvailable;
      }
      if ((q as { syllabusTopic?: string | null }).syllabusTopic) {
        syllabusTopics[q.questionNum] = (q as { syllabusTopic?: string | null }).syllabusTopic!;
      }
    }
  }

  // Auto-detect skip pages and comprehension passage pages for English exams.

  // 1. Skip pages: all pages belonging to Writing / Listening papers (skipExtraction: true)
  const skipExtractLabels = new Set(
    structure.papers.filter(p => p.skipExtraction).map(p => p.label)
  );
  const skipPages: number[] = skipExtractLabels.size === 0 ? [] :
    structure.pages
      .filter(p => !p.isAnswerSheet && p.paperLabel && skipExtractLabels.has(p.paperLabel))
      .map(p => p.pageIndex + 1) // 1-based
      .sort((a, b) => a - b);
  if (skipPages.length > 0) {
    console.log(`[Exam Pipeline] Auto-detected skip pages (Writing/Listening) (1-based): ${skipPages.join(", ")}`);
  }

  // 2. Passage pages: pages in Booklet A (English Paper 2) with no questions extracted.
  // These are the reading passage pages students need when answering open-ended questions.
  let passagePages: number[] = [];
  if ((structure.header.subject ?? "").toLowerCase().includes("english")) {
    // Find the Booklet A entry (label contains "Booklet A" or "booklet a")
    const bookletAEntry = bookletPageRanges.find(b =>
      b.paper.label.toLowerCase().includes("booklet a")
    );
    if (bookletAEntry && bookletAEntry.pageIndices.length > 0) {
      const bookletAPageSet = new Set(bookletAEntry.pageIndices);
      // Pages that had at least one question extracted
      const pagesWithQuestions = new Set(
        questionResult.pages
          .filter(p => bookletAPageSet.has(p.pageIndex) && p.questions.length > 0)
          .map(p => p.pageIndex)
      );
      // Pages in Booklet A with no questions = reading passage pages
      passagePages = [...bookletAPageSet]
        .filter(idx => !pagesWithQuestions.has(idx))
        .sort((a, b) => a - b)
        .map(i => i + 1); // 1-based
      if (passagePages.length > 0) {
        console.log(`[Exam Pipeline] Auto-detected comprehension passage pages from Booklet A (1-based): ${passagePages.join(", ")}`);
      }
    }
  }

  return {
    header: structure.header,
    pages,
    answers: answerResult.answers,
    marksPerQuestion,
    syllabusTopics: Object.keys(syllabusTopics).length > 0 ? syllabusTopics : undefined,
    _debug: {
      papers: structure.papers.map(p => ({
        label: p.label,
        questionPrefix: p.questionPrefix,
        questionsStartPage: p.firstQuestionPageIndex + 1, // 1-based for easy PDF comparison
        questionsStartY: p.firstQuestionYStartPct,
        expectedQuestions: p.expectedQuestionCount,
        ...(p.skipExtraction ? { skipExtraction: true } : {}),
      })),
      coverPages: coverPageEntries.map(p => p.pageIndex + 1), // 1-based
      answerPages: answerPageEntries.map(p => p.pageIndex + 1), // 1-based
      skipPages,
      passagePages,
      answersDetected: Object.keys(answerResult.answers),
      questionsPerPage: questionResult.pages.map(p => ({
        page: p.pageIndex + 1, // 1-based
        questions: p.questions.map(q => q.questionNum),
      })),
      validationIssues: finalValidation.issues,
      rawResponses: Object.fromEntries(
        bookletResults.map((r, i) => [bookletPageRanges[i].paper.label, r._rawSnippet ?? "(empty)"])
      ),
    },
  };
}

// --- Single question re-extraction ---

const REDO_QUESTION_PROMPT = `Find question "{questionNum}" on these exam paper page(s) and provide precise crop boundaries.

You are given {pageCount} page(s). Page 1 is the primary page, Page 2 (if present) is the next page.
The question may be on EITHER page — search both.

Context: {context}

## The ONE rule:
- yStartPct = top of question "{questionNum}" on the page, minus ~1% padding (just a tiny gap above)
- yEndPct = top of the NEXT WHOLE question number (e.g. the number AFTER "{questionNum}"), plus ~1% padding DOWNWARD
- EVERYTHING between two consecutive WHOLE question numbers belongs to this question
- TOP padding should be MINIMAL — do NOT extend far above the question number

## WHERE to find question numbers — LEFT MARGIN ONLY:
- Question numbers are ALWAYS at the LEFT-MOST margin of the page
- ONLY look at the left margin — NEVER use numbers from the middle or right of the page
- MCQ options like "(1)", "(2)", "(3)", "(4)" appear INDENTED — these are NOT question numbers

## What is a "question number" vs what is NOT:
- Question numbers: "1.", "2.", "24.", "25." at the LEFT MARGIN — use these as boundaries
- NOT question numbers: "(a)", "(b)", "(c)", "(i)", "(ii)" — sub-parts INSIDE a question, IGNORE as boundaries
- NOT question numbers: "(1)", "(2)", "(3)", "(4)" indented under a question — MCQ OPTIONS, not boundaries
- If question {questionNum} has sub-parts (a)(b)(c), include ALL of them — cut at the NEXT whole question number

## Guidance:
- yStartPct = 0 means top of page, yEndPct = 100 means bottom of page
- If this is the last question on the page, extend yEndPct to just before the footer (90-95%)
- Written questions are large (15-50% of page) — if your crop is small, you are cutting off too early
- Better to crop too much than to cut off content
- NEVER output invalid coordinates (yStartPct >= yEndPct)

## pageOffset:
- pageOffset = 0 if the question is on Page 1 (the primary page)
- pageOffset = 1 if the question is on Page 2 (the next page)
- yStartPct and yEndPct are RELATIVE to the page where the question was found

Return ONLY valid JSON: { "questionNum": "{questionNum}", "pageOffset": 0, "yStartPct": 15.0, "yEndPct": 45.0 }`;

export async function redoQuestionExtraction(
  imagesBase64: string[],
  questionNum: string,
  surroundingQuestions: string[],
  hints?: {
    isFirstInBooklet?: boolean;
    previousBoundary?: { yEndPct: number; yStartPct: number; questionNum: string } | null;
  }
): Promise<{ questionNum: string; pageOffset: number; yStartPct: number; yEndPct: number }> {
  const contextLines: string[] = [];
  if (surroundingQuestions.length > 0) {
    contextLines.push(`Other questions on Page 1: ${surroundingQuestions.join(", ")}`);
  } else {
    contextLines.push("This may be the only question on Page 1.");
  }

  if (hints?.isFirstInBooklet) {
    contextLines.push(`This is the FIRST question in this booklet/paper. It should appear near the top of Page 1.`);
  } else if (hints?.previousBoundary) {
    const prev = hints.previousBoundary;
    contextLines.push(
      `The previous question (Q${prev.questionNum}) ends at approximately ${prev.yEndPct.toFixed(1)}% from the top of Page 1.` +
      ` Question "${questionNum}" should START just after that point on Page 1, OR at the top of Page 2 if not found on Page 1.` +
      ` Do NOT search above ${Math.max(0, prev.yStartPct).toFixed(0)}% on Page 1 — that region belongs to Q${prev.questionNum}.`
    );
  }

  if (imagesBase64.length > 1) {
    contextLines.push(`If question "${questionNum}" is NOT on Page 1, check Page 2 — it may start at the top of the next page.`);
  }

  const context = contextLines.join("\n");

  const prompt = REDO_QUESTION_PROMPT
    .replaceAll("{questionNum}", questionNum)
    .replace("{context}", context)
    .replace("{pageCount}", String(imagesBase64.length));

  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${i + 1}]` },
  ]).flat();

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: prompt }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text) as {
    questionNum: string;
    pageOffset: number;
    yStartPct: number;
    yEndPct: number;
  };
}

// --- Single answer re-extraction ---

const REDO_ANSWER_PROMPT = `Find the answer for question "{questionNum}" on this answer key page.
{paperContextLine}
The page is an answer key / answer sheet from a Singapore school exam paper.
Question labels may appear as "Q{questionNum}", "Q{questionNum})", "{questionNum}.", "{questionNum})", or just "{questionNum}" — possibly inside a table.

## How to find the answer:
- Look for the question number "{questionNum}" on this page
- MCQ answers are often in a TABLE: question number in one column, answer in the adjacent cell
- Written answers show workings and/or a final answer below the question number
- The answer may span multiple lines with mathematical steps
- IMPORTANT: Copy MCQ answers EXACTLY as printed — Singapore exams often use (1), (2), (3), (4) instead of A, B, C, D. If it says "(3)", output "(3)" — do NOT convert to "C"

## Classify the answer:

**Type "text"** — Use for MOST answers (preferred):
- MCQ answer — copy EXACTLY as printed: "(3)", "(1)", "C", "A", etc.
- Short answers, numerical answers
- Worked solutions that can be written as text: "3/4 × 12 = 9 | Ans: 9"
- Sub-parts: "(a) 24 cm² | (b) 15 cm"
- Transcribe EVERY line — do NOT skip or truncate. Use " | " to separate steps.
- IMPORTANT: Do NOT use literal newlines — use " | " as separator.

**Type "image"** — ONLY when text cannot capture the answer:
- Contains diagrams, drawings, graphs, or geometric constructions
- Complex notation that cannot be typed
- Do NOT use image just because the answer has multiple steps

## For "image" type:
- Provide yStartPct and yEndPct crop boundaries on THIS page
- Crop TIGHTLY — NO extra padding
- value: marking guidance — describe what to check when comparing a student's answer (e.g. required elements, what deducts marks). If purely decorative, use empty string.

## Return format:
For text: { "type": "text", "value": "B" }
For worked text: { "type": "text", "value": "(a) 3/4 × 12 = 9 | (b) 9 + 6 = 15 | Ans: 15 cm" }
For image: { "type": "image", "yStartPct": 45.0, "yEndPct": 55.0, "value": "Student must draw a triangle with height 6cm and base 8cm. Right angle must be marked." }

If you CANNOT find question "{questionNum}" on this page, return: { "type": "text", "value": "" }`;

export async function redoAnswerExtraction(
  imageBase64: string,
  questionNum: string,
  paperContext: string = ""
): Promise<AnswerEntry> {
  const paperContextLine = paperContext
    ? `\nIMPORTANT: This answer key page is for "${paperContext}". Only look for question ${questionNum} under the "${paperContext}" section. Do NOT match answers from a different paper or section.`
    : "";
  const prompt = REDO_ANSWER_PROMPT
    .replaceAll("{questionNum}", questionNum)
    .replace("{paperContextLine}", paperContextLine);

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) return { type: "text", value: "" };

  const result = JSON.parse(sanitizeJsonString(text)) as { type: string; value: string; yStartPct?: number; yEndPct?: number };

  if (result.type === "image" && result.yStartPct != null && result.yEndPct != null) {
    return {
      type: "image",
      answerPageIndex: 0, // will be set by the caller
      yStartPct: result.yStartPct,
      yEndPct: result.yEndPct,
      value: result.value || "",
    };
  }

  return { type: "text", value: result.value || "" };
}

// --- Validate cropped question image ---

const VALIDATE_CROP_PROMPT = `Look at this cropped image from an exam paper. I expect this to be question "{questionNum}".

Check TWO things:
1. Is the question number "{displayNum}" (or close to it) visible near the TOP of this image?
2. Does this image contain actual exam question content (not blank/empty)?

Return JSON: { "valid": true/false, "reason": "short explanation" }

- valid = true if the question number is visible near the top AND the image has real content
- valid = false if the image is blank, or the question number is not visible, or a completely different question is shown`;

export async function validateQuestionCrop(
  croppedImageBase64: string,
  questionNum: string
): Promise<{ valid: boolean; reason: string }> {
  // Strip P2-/B2- prefix to get the number printed on the page
  const displayNum = questionNum.replace(/^(P\d+-|B\d+-)/, "").replace(/[a-z]$/i, m => `(${m})`);

  const prompt = VALIDATE_CROP_PROMPT
    .replaceAll("{questionNum}", questionNum)
    .replaceAll("{displayNum}", displayNum);

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: croppedImageBase64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) return { valid: false, reason: "Empty AI response" };
  return JSON.parse(text) as { valid: boolean; reason: string };
}

const wordInfoCache = new Map<string, WordInfo>();

export async function generateWordInfo(
  word: string,
  language: "CHINESE" | "ENGLISH" | "JAPANESE"
): Promise<WordInfo> {
  const cacheKey = `${language}:${word}`;
  const cached = wordInfoCache.get(cacheKey);
  if (cached) return cached;

  const prompt =
    language === "CHINESE"
      ? MEANING_PROMPT_ZH.replace("{word}", word)
      : language === "JAPANESE"
      ? MEANING_PROMPT_JA.replace("{word}", word)
      : MEANING_PROMPT_EN.replace("{word}", word);

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.3,
    },
  });

  const text = response.text?.trim();
  if (!text) return { meaning: word, example: "" };

  try {
    const info = JSON.parse(text) as WordInfo;
    wordInfoCache.set(cacheKey, info);
    return info;
  } catch {
    return { meaning: word, example: "" };
  }
}
