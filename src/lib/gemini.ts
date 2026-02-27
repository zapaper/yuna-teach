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

// --- Batch Exam Analysis (all pages in one call) ---

const BATCH_ANALYSIS_PROMPT = `You are an expert at analyzing Singapore primary/secondary school exam papers. All pages of the exam are provided as images in order.

## STEP 1: First pass — Read the ENTIRE paper to understand structure
Before extracting any questions, scan ALL pages to determine:
- The header/cover page instructions which tell you the exam structure
- How many total questions there are and how they are scored
- How the paper is segmented (e.g. "Booklet A" and "Booklet B", or "Section A" and "Section B")
- Where the answer sheet / answer key is (usually at the end)

## STEP 2: Read header instructions VERY carefully
The cover page or top of the first page contains critical metadata:
- School name, level (P1-P6, Sec 1-4), subject, year, exam type
- Total marks and duration
- Section breakdown with EXACT question count and marks per section
  e.g. "Section A: 28 questions x 1 mark = 28 marks", "Section B: 12 questions x 2 marks = 24 marks"
- This tells you EXACTLY how many questions to find in each section — use this as your guide
- Sometimes it says "Booklet A" (MCQ) and "Booklet B" (structured/written) — treat each booklet as a section

## STEP 3: Extract questions section by section

### MCQ Section (usually Section A / Booklet A — comes FIRST)
- The header tells you how many MCQ questions (e.g. 28 questions at 1 mark each)
- Each MCQ has a question stem followed by answer options: (A)(B)(C)(D) or (1)(2)(3)(4)
- Each MCQ is a SEPARATE entry — do NOT merge multiple MCQs together
- Include BOTH the stem AND all answer options in the crop

### Written / Structured Section (usually Section B / Booklet B — comes AFTER MCQ)
- Fewer questions, each worth more marks
- Questions have sub-parts: (a), (b), (c) or (i), (ii), (iii)
- SPLIT sub-parts into SEPARATE entries: e.g. Question 22 with parts (a) and (b) becomes "22a" and "22b"
- Each sub-part entry includes the sub-part label, its text, diagrams, AND the answer space/lines
- Include the "Ans:" line or answer box/space if present — this is part of the question
- Include any blank lines or working space given for that sub-part

## STEP 4: Detect answer sheets
- Usually at the END of the document
- Titled "Answer Key", "Answers", or a table mapping question numbers to answers
- Mark these pages as isAnswerSheet: true
- Extract all answers, matching the question numbering format (e.g. "1", "22a", "22b")

## OUTPUT FORMAT
Return a JSON object with:

1. "header":
   - school, level, subject, year, semester, title
   - totalMarks: total marks as string (e.g. "100"), empty string if unknown
   - sections: array of sections, e.g. [{"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}, {"name": "B", "type": "structured", "marks": 52, "questionCount": 8}]

2. "pages": array with one entry per page:
   - pageIndex: 0-based page number
   - isAnswerSheet: true/false
   - questions: array of questions on this page, each with:
     - questionNum: e.g. "1", "2", "28", "29a", "29b", "30"
     - yStartPct: Y-coordinate where question starts (0=top, 100=bottom)
     - yEndPct: Y-coordinate where question ends

3. "answers": object mapping question numbers to answer text
   Example: { "1": "B", "2": "A", "29a": "3/4", "29b": "15 cm" }

## CRITICAL RULES for yStartPct / yEndPct boundaries:
- yStartPct = the TOP of the question number text, MINUS 2-3% padding (white space above)
- yEndPct = just ABOVE the next question's number, giving 2-3% white space below
- In other words: start from a bit of white space above the question number, end at a bit of white space below the last line of the question (before the next question number starts)
- NEVER cut off the question number at the top or the last line / answer space at the bottom
- For MCQ: crop from question number through all 4 answer options
- For written questions: crop from question number through the answer space ("Ans:" line, answer box, or blank lines)
- For written sub-parts (a, b): each sub-part's crop starts from its label "(a)" and ends before the next sub-part label "(b)" or next question
- If a question continues from a previous page, start from the very TOP of the page (yStartPct = 0 or 1)
- If a question is the last on a page, extend yEndPct to just before the footer/page number
- No gaps — yEndPct of Q(n) ≈ yStartPct of Q(n+1)
- Skip page headers (school name repeated at top) and footers (page numbers)

Return ONLY valid JSON.`;

export interface BatchAnalysisResult {
  header: ExamHeaderInfo;
  pages: Array<{
    pageIndex: number;
    isAnswerSheet: boolean;
    questions: Array<{
      questionNum: string;
      yStartPct: number;
      yEndPct: number;
    }>;
  }>;
  answers: Record<string, string>;
}

export async function analyzeExamBatch(
  imagesBase64: string[]
): Promise<BatchAnalysisResult> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${i + 1} of ${imagesBase64.length}]` },
  ]).flat();

  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: BATCH_ANALYSIS_PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text) as BatchAnalysisResult;
}

// --- Single question re-extraction ---

const REDO_QUESTION_PROMPT = `You are re-analyzing a specific question from a Singapore primary/secondary school exam paper page.

I need you to find question "{questionNum}" on this page and provide precise boundaries for cropping.

Context about surrounding questions on this page:
{context}

## How to determine boundaries:
- yStartPct = the TOP of the question number text, MINUS 2-3% padding (white space above)
- yEndPct = just ABOVE the next question's number, giving 2-3% white space below
- yStartPct = 0 means top of page, yEndPct = 100 means bottom of page
- NEVER cut off the question number at the top or the last line / answer space at the bottom

## Rules by question type:

### If "{questionNum}" is an MCQ (e.g. "1", "2", "15"):
- Include the question stem AND all answer options (A/B/C/D or 1/2/3/4)
- Crop from the question number through the last answer option

### If "{questionNum}" is a written sub-part (e.g. "22a", "22b"):
- This is a sub-part of a larger question
- Crop from the sub-part label "(a)" or "(b)" to just before the next sub-part or next question
- Include any answer space: "Ans:" lines, answer boxes, blank working space

### If "{questionNum}" is a full written question (e.g. "29", "30"):
- Include the question text, any diagrams, and the answer space
- Include "Ans:" lines, answer boxes, or blank lines provided for the answer
- If the question has sub-parts that are NOT being split, include ALL sub-parts

## Critical:
- Add 2-3% white space padding ABOVE and BELOW the question content
- Better to crop slightly too much than to cut off any part of the question

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
