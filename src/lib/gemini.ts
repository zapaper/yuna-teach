import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }
  return _ai;
}

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
   - The language: "CHINESE" if the test words are Chinese characters, "ENGLISH" if English words
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

export async function extractWords(ocrText: string) {
  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: EXTRACTION_PROMPT.replace("{ocrText}", ocrText),
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
      language: "CHINESE" | "ENGLISH";
      words: Array<{ text: string; orderIndex: number }>;
    }>;
  };
}

const MEANING_PROMPT_ZH = `You are a primary school Chinese teacher in Singapore.
For the Chinese word or phrase "{word}", provide:
1. pinyin: the hanyu pinyin with tone marks (e.g. "zhǒng zú")
2. meaning: a brief meaning in Chinese, under 15 characters (e.g. "人类按肤色、语言等分的类别")
3. example: a simple example sentence in Chinese that a Primary 3-4 student would understand, under 20 characters (e.g. "新加坡有很多种族。")

Return ONLY valid JSON: {"pinyin": "...", "meaning": "...", "example": "..."}`;

const MEANING_PROMPT_EN = `You are a primary school English teacher.
For the word "{word}", provide:
1. meaning: a brief kid-friendly definition, under 10 words (e.g. "to have fun for a special day")
2. example: a simple example sentence a primary school student would understand, under 15 words (e.g. "We celebrate birthdays with cake and songs.")

Return ONLY valid JSON: {"meaning": "...", "example": "..."}`;

export interface WordInfo {
  pinyin?: string;
  meaning: string;
  example: string;
}

// --- Exam Paper Analysis ---

const HEADER_ANALYSIS_PROMPT = `You are analyzing the first page of a Singapore school exam paper.
Extract the following information from this exam paper image:
1. school: The school name (e.g. "Anglo-Chinese School (Junior)")
2. level: The student level (e.g. "P6", "P5", "Sec 4")
3. subject: The subject (e.g. "Mathematics", "Science", "English")
4. year: The year of the exam (e.g. "2024")
5. semester: The exam type or semester (e.g. "Prelim", "SA2", "CA1", "Mid-Year")
6. title: A short descriptive title combining school abbreviation, level, subject, and exam type (e.g. "ACSJ P6 Math Prelim 2024")

If any field cannot be determined, use an empty string.
Return ONLY valid JSON with these exact fields: school, level, subject, year, semester, title.`;

export interface ExamHeaderInfo {
  school: string;
  level: string;
  subject: string;
  year: string;
  semester: string;
  title: string;
  totalMarks?: string;
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
  const response = await getAI().models.generateContent({
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

  const response = await getAI().models.generateContent({
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

  const response = await getAI().models.generateContent({
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
- sections: array of sections with exact breakdown from the header
  e.g. "Section A: 28 questions x 1 mark = 28 marks" → {"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}

### 2. Page classification
For EVERY page, determine whether it is:
- A question page (isAnswerSheet: false) — contains exam questions for students to attempt
- An answer sheet / answer key page (isAnswerSheet: true) — contains answers, solutions, or marking scheme
- Answer keys are usually at the END of the document, titled "Answer Key", "Answers", "Marking Scheme", or contain answer tables

### 3. Multi-paper detection
Check if the PDF contains MULTIPLE papers (Paper 1 + Paper 2, Booklet A + Booklet B):
- Look for question numbers that RESET back to 1
- Look for new cover pages or headers appearing mid-document
- Look for labels like "Paper 2", "Booklet B", "Part 2"
If multiple papers exist, define each with:
- label: e.g. "Paper 1", "Paper 2"
- questionPrefix: "" for Paper 1, "P2-" for Paper 2 (used to keep question numbers unique)
- expectedQuestionCount: how many questions expected based on header info
- sections: breakdown per section

### 4. For each page, note which paper it belongs to (paperLabel)

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "header": {
    "school": "...", "level": "...", "subject": "...", "year": "...",
    "semester": "...", "title": "...", "totalMarks": "...",
    "sections": [{"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}]
  },
  "pages": [
    {"pageIndex": 0, "isAnswerSheet": false, "paperLabel": "Paper 1"},
    {"pageIndex": 1, "isAnswerSheet": false, "paperLabel": "Paper 1"},
    {"pageIndex": 8, "isAnswerSheet": true, "paperLabel": "Paper 1"}
  ],
  "papers": [
    {
      "label": "Paper 1",
      "questionPrefix": "",
      "expectedQuestionCount": 36,
      "sections": [{"name": "A", "type": "MCQ", "questionCount": 28}, {"name": "B", "type": "structured", "questionCount": 8}]
    }
  ]
}

If there is only one paper, still include it in the "papers" array with questionPrefix "".
Return ONLY valid JSON.`;

// Stage 2a: Question Extraction — extract question boundaries from question pages only
const QUESTION_EXTRACTION_PROMPT = `You are an expert at extracting question boundaries from Singapore school exam papers.

You are given ONLY the question pages of the exam (answer sheets have been removed). Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract EVERY question's crop boundaries

### The ONE rule for ALL questions (MCQ and written alike):
- yStartPct = top of this question's number (e.g. "5."), minus 2-3% padding
- yEndPct = top of the NEXT WHOLE question number (e.g. "6."), minus 1%
- EVERYTHING between two consecutive WHOLE question numbers belongs to the first question
- Each question is ONE entry — do NOT split sub-parts (a), (b), (c) into separate entries

### WHERE to find question numbers — LEFT MARGIN ONLY:
- Question numbers are ALWAYS printed at the LEFT-MOST margin of the page
- ONLY look at the left margin — NEVER use numbers from the middle or right of the page
- MCQ answer options like "(1)", "(2)", "(3)", "(4)" appear INDENTED — these are NOT question numbers
- The pattern is: a number followed by a period or bracket at the very start of a line

### What counts as a "question number" (boundary marker):
- YES: "1.", "2.", "3.", "24.", "25." — WHOLE question numbers at the LEFT MARGIN
- NO: "(a)", "(b)", "(c)", "(i)", "(ii)" — sub-parts, IGNORE as boundaries
- NO: "(1)", "(2)", "(3)", "(4)" indented under a question — MCQ OPTIONS, not boundaries

### Sequential extraction:
- Extract questions in order: 1, 2, 3, 4...
- Use the PREVIOUS question's yEndPct to guide the NEXT question's yStartPct (no gaps)
- On a new page: first question starts near the top (after page header), last question extends to near the bottom (before footer)

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

### Validation:
- Questions must be sequential within each paper
- If numbers jump (e.g. 5, 6, 10), look more carefully — you likely missed questions
- The total extracted questions should match the expected count from the structure analysis
- NEVER output invalid coordinates (yStartPct >= yEndPct)
- When in doubt, crop MORE — extra white space is better than cutting off content

### Edge cases:
- Question continues from previous page: yStartPct = 0 or 1
- Last question on page: yEndPct = just before footer/page number (90-95%)
- Skip page headers and footers

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "pages": [
    {
      "pageIndex": 2,
      "questions": [
        {"questionNum": "1", "yStartPct": 12.0, "yEndPct": 35.0, "boundaryTop": "1", "boundaryBottom": "2"},
        {"questionNum": "2", "yStartPct": 35.0, "yEndPct": 58.0, "boundaryTop": "2", "boundaryBottom": "3"}
      ]
    }
  ]
}

Return ONLY valid JSON.`;

// Stage 2b: Answer Extraction — extract answers with full working steps from answer key pages
const ANSWER_EXTRACTION_PROMPT_V2 = `You are analyzing the answer key / answer sheet pages of a Singapore school exam paper.

You are given ONLY the answer key pages. Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract ALL answers with FULL WORKING STEPS

### CRITICAL REQUIREMENT — Capture working steps, not just final answers:
- For math/science questions, the WORKING is as important as the final answer
- Prefer "image" type for ANY answer that has working steps, method marks, or multi-step solutions
- Only use "text" type for simple MCQ answers (A/B/C/D) or very short one-word/one-number answers with NO working shown
- When in doubt, use "image" type — it preserves the full worked solution

### How to read answer keys:
- Question labels may appear as "Q24", "Q24)", "Q1", "24.", "1)", or just "24"
- Strip the "Q" prefix and any punctuation to get the question number
- MCQ answer keys are often in TABLE format: question number in one column, answer letter in adjacent cell
- Written answer keys show full working for each question
- Some answer keys mix formats: MCQ table at top, worked solutions below

### For multi-paper PDFs:
- Identify which paper the answers belong to by reading the HEADER on the answer key page
- "Paper 1" / "Booklet A" → no prefix (questions "1", "2", "3")
- "Paper 2" / "Booklet B" → use prefix (questions "P2-1", "P2-2", "P2-3")
- If no header specifies, assume answers for the main (only) paper

### Classify each answer:

**Type "text"** — Use ONLY for:
- MCQ answers (single letter: A, B, C, D)
- Answers that are TRULY just a single short value with NO working shown (rare for non-MCQ)

**Type "image"** — Use for EVERYTHING ELSE, including:
- Any answer that shows working steps (e.g. math working, long division, algebra)
- Short answers like "3/4" or "15 cm" IF the answer key shows the METHOD to get there
- Answers with diagrams, drawings, graphs
- Multi-line answers
- Any answer where the working/method is visible in the answer key
- When in doubt, ALWAYS prefer "image"

### For "image" type answers:
- answerPageIndex: the ORIGINAL 0-based page index (as labeled on the image)
- yStartPct: Y-coordinate where this answer starts on that page (0=top, 100=bottom)
- yEndPct: Y-coordinate where this answer ends on that page
- Include ALL workings, steps, diagrams, and the final answer in the crop
- Add 1-2% padding above and below
- value: the FULL working steps as text, including equations, intermediate steps, and the final answer. Transcribe EVERY line in the answer cell/block — do NOT skip or truncate the last line. Use line breaks to separate steps. For example: "(a) 3/4 × 12 = 9\n(b) 9 + 6 = 15\nAns: 15 cm". If the question has sub-parts (a), (b), (c), include ALL sub-part answers with their labels. If the answer is purely visual (diagram only), use empty string.

### For "text" type answers:
- value: the answer string (e.g. "B", "C")

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "answers": {
    "1": {"type": "text", "value": "B"},
    "2": {"type": "text", "value": "A"},
    "29": {"type": "image", "answerPageIndex": 8, "yStartPct": 10.0, "yEndPct": 30.0, "value": "(a) 3/4 × 12 = 9\n(b) 9 + 6 = 15\nAns: 15 cm"},
    "P2-1": {"type": "image", "answerPageIndex": 12, "yStartPct": 5.0, "yEndPct": 25.0, "value": "(a) Area = 1/2 × 8 × 6 = 24 cm²\n(b) Perimeter = 8 + 6 + 10 = 24 cm"}
  }
}

Return ONLY valid JSON.`;

// --- Intermediate types for the 3-stage pipeline ---

interface StructureResult {
  header: ExamHeaderInfo;
  pages: Array<{
    pageIndex: number;
    isAnswerSheet: boolean;
    paperLabel?: string;
  }>;
  papers: Array<{
    label: string;
    questionPrefix: string;
    expectedQuestionCount: number;
    sections: Array<{ name: string; type: string; questionCount: number }>;
  }>;
}

interface QuestionExtractionResult {
  pages: Array<{
    pageIndex: number;
    questions: Array<{
      questionNum: string;
      yStartPct: number;
      yEndPct: number;
      boundaryTop: string;
      boundaryBottom: string;
    }>;
  }>;
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
    lines.push(`\n${paper.label} (prefix: "${paper.questionPrefix}", expected ${paper.expectedQuestionCount} questions):`);
    for (const section of paper.sections) {
      lines.push(`  - Section ${section.name}: ${section.type}, ${section.questionCount} questions`);
    }
  }
  const questionPages = structure.pages.filter(p => !p.isAnswerSheet);
  const answerPages = structure.pages.filter(p => p.isAnswerSheet);
  lines.push(`\nQuestion pages (0-based): ${questionPages.map(p => p.pageIndex).join(", ")}`);
  lines.push(`Answer pages (0-based): ${answerPages.map(p => p.pageIndex).join(", ")}`);
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

  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
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
  return JSON.parse(text) as StructureResult;
}

// Stage 2a: Extract question boundaries (question pages only)
async function extractQuestions(
  imagesBase64: string[],
  originalPageIndices: number[],
  structure: StructureResult
): Promise<QuestionExtractionResult> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${originalPageIndices[i]}]` },
  ]).flat();

  const prompt = QUESTION_EXTRACTION_PROMPT.replace(
    "{structureContext}",
    buildStructureContext(structure)
  );

  const response = await getAI().models.generateContent({
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
  if (!text) throw new Error("Gemini returned empty response for question extraction");
  return JSON.parse(text) as QuestionExtractionResult;
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

  const response = await getAI().models.generateContent({
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
  if (!text) throw new Error("Gemini returned empty response for answer extraction");
  return JSON.parse(text) as AnswerExtractionResult;
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
    questions: Array<{
      questionNum: string;
      yStartPct: number;
      yEndPct: number;
      boundaryTop: string;
      boundaryBottom: string;
    }>;
  }>;
  answers: Record<string, AnswerEntry>;
}

export async function analyzeExamBatch(
  imagesBase64: string[]
): Promise<BatchAnalysisResult> {
  // --- Stage 1: Structure analysis (all pages) ---
  const structure = await analyzeExamStructure(imagesBase64);

  // --- Partition pages into question pages and answer pages ---
  const questionPageEntries = structure.pages.filter(p => !p.isAnswerSheet);
  const answerPageEntries = structure.pages.filter(p => p.isAnswerSheet);

  const questionImages = questionPageEntries.map(p => imagesBase64[p.pageIndex]);
  const questionPageIndices = questionPageEntries.map(p => p.pageIndex);

  const answerImages = answerPageEntries.map(p => imagesBase64[p.pageIndex]);
  const answerPageIndices = answerPageEntries.map(p => p.pageIndex);

  // --- Stage 2a + 2b: Run concurrently ---
  const [questionResult, answerResult] = await Promise.all([
    questionImages.length > 0
      ? extractQuestions(questionImages, questionPageIndices, structure)
      : { pages: [] } as QuestionExtractionResult,
    answerImages.length > 0
      ? extractAnswersWithWorking(answerImages, answerPageIndices, structure)
      : { answers: {} } as AnswerExtractionResult,
  ]);

  // --- Combine into BatchAnalysisResult ---
  const pages: BatchAnalysisResult["pages"] = [];

  // Add question pages with their extracted questions
  for (const qPage of questionResult.pages) {
    pages.push({
      pageIndex: qPage.pageIndex,
      isAnswerSheet: false,
      questions: qPage.questions,
    });
  }

  // Add answer pages (flagged as answer sheets, no questions)
  for (const aPage of answerPageEntries) {
    pages.push({
      pageIndex: aPage.pageIndex,
      isAnswerSheet: true,
      questions: [],
    });
  }

  // Sort pages by pageIndex to match original document order
  pages.sort((a, b) => a.pageIndex - b.pageIndex);

  return {
    header: structure.header,
    pages,
    answers: answerResult.answers,
  };
}

// --- Single question re-extraction ---

const REDO_QUESTION_PROMPT = `Find question "{questionNum}" on this exam paper page and provide precise crop boundaries.

Context: {context}

## The ONE rule:
- yStartPct = top of question "{questionNum}" on the page, minus 2-3% padding
- yEndPct = top of the NEXT WHOLE question number (e.g. the number AFTER "{questionNum}"), minus 1%
- EVERYTHING between two consecutive WHOLE question numbers belongs to this question

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

Return ONLY valid JSON: { "questionNum": "{questionNum}", "yStartPct": 15.0, "yEndPct": 45.0 }`;

export async function redoQuestionExtraction(
  imageBase64: string,
  questionNum: string,
  surroundingQuestions: string[]
): Promise<{ questionNum: string; yStartPct: number; yEndPct: number }> {
  const context =
    surroundingQuestions.length > 0
      ? `Other questions on this page: ${surroundingQuestions.join(", ")}`
      : "This may be the only question on this page.";

  const prompt = REDO_QUESTION_PROMPT.replaceAll("{questionNum}", questionNum).replace(
    "{context}",
    context
  );

  const response = await getAI().models.generateContent({
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
  return JSON.parse(text) as {
    questionNum: string;
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
- MCQ answers are often in a TABLE: question number in one column, answer letter (A/B/C/D) in the adjacent cell
- Written answers show workings and/or a final answer below the question number
- The answer may span multiple lines with mathematical steps

## Classify the answer:

**Type "text"** — ONLY for:
- MCQ answer (single letter: A, B, C, D)
- Answers that are truly just a single short value with NO working shown

**Type "image"** — for EVERYTHING ELSE:
- Worked solution with mathematical steps
- Contains diagrams, drawings, or pictures
- Multi-line answer where layout matters
- Any answer where working/method is visible
- When in doubt, ALWAYS prefer "image"

## For "image" type:
- Provide yStartPct and yEndPct crop boundaries on THIS page
- Include ALL workings, steps, and the final answer
- Add 1-2% padding above and below
- value: the FULL working steps as text, including equations and intermediate steps. Transcribe EVERY line — do NOT skip or truncate the last line. If the question has sub-parts (a), (b), (c), include ALL sub-part answers. Use line breaks to separate steps. E.g. "(a) 3/4 × 12 = 9\n(b) 9 + 6 = 15\nAns: 15 cm"

## For "text" type:
- Provide the answer text in the "value" field

Return ONLY valid JSON:
For text: { "type": "text", "value": "B" }
For image: { "type": "image", "yStartPct": 15.0, "yEndPct": 35.0, "value": "(a) 3/4 × 12 = 9\n(b) 9 + 6 = 15\nAns: 15 cm" }

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

  const response = await getAI().models.generateContent({
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

  const result = JSON.parse(text) as { type: string; value: string; yStartPct?: number; yEndPct?: number };

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

  const response = await getAI().models.generateContent({
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
  language: "CHINESE" | "ENGLISH"
): Promise<WordInfo> {
  const cacheKey = `${language}:${word}`;
  const cached = wordInfoCache.get(cacheKey);
  if (cached) return cached;

  const prompt =
    language === "CHINESE"
      ? MEANING_PROMPT_ZH.replace("{word}", word)
      : MEANING_PROMPT_EN.replace("{word}", word);

  const response = await getAI().models.generateContent({
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
