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

## STEP 1: Read the cover page / header instructions carefully
The first page or top of the first page usually contains critical information:
- School name, level (P1-P6, Sec 1-4), subject, year, exam type (SA1, SA2, Prelim, CA1, Mid-Year)
- Total marks and duration
- Section breakdown, e.g. "Section A: 20 marks (20 MCQ questions)", "Section B: 40 marks (4 structured questions)"
- USE THIS to know exactly how many questions to expect and their structure

## STEP 2: Understand typical exam paper structure

### Section A — Multiple Choice Questions (MCQ)
- Usually comes FIRST in the paper
- The header will tell you how many MCQ questions (e.g. 20 marks = typically 10 or 20 MCQ questions, 1-2 marks each)
- Each MCQ question has a question stem followed by answer options labeled either:
  (A), (B), (C), (D) — OR — (1), (2), (3), (4)
- A single MCQ question includes BOTH the stem AND all its answer options
- MCQ questions are usually compact — do NOT merge multiple MCQ questions into one
- Each MCQ is a SEPARATE question entry (e.g. Q1, Q2, Q3... up to Q10 or Q20)

### Section B / C — Structured / Open-ended / Written Questions
- Comes AFTER the MCQ section
- Fewer questions but each is larger and worth more marks
- Questions often have sub-parts: (a), (b), (c) or (i), (ii), (iii)
- Keep the ENTIRE question together including ALL its sub-parts as ONE entry
- Only split sub-parts into separate entries if they are on different pages or very long (half a page each)
- Include ALL content: diagrams, tables, graphs, images, working space indicators

## STEP 3: Detect answer sheets
- Answer sheets / answer keys are usually at the END of the document
- They may be titled "Answer Key", "Answers", or show a table of question numbers and answers
- Mark these pages as isAnswerSheet: true
- Extract all answers from them

## OUTPUT FORMAT
Return a JSON object with:

1. "header": Extract from the cover/first page:
   - school, level, subject, year, semester, title (same as before)
   - totalMarks: total marks as a string (e.g. "60"), empty string if unknown
   - sections: array of sections found, e.g. [{"name": "A", "type": "MCQ", "marks": 20, "questionCount": 20}]

2. "pages": array with one entry per page:
   - pageIndex: 0-based page number
   - isAnswerSheet: true/false
   - questions: array of questions on this page, each with:
     - questionNum: question number as shown (e.g. "1", "2", "15", "21")
     - yStartPct: Y-coordinate where question starts (0=top, 100=bottom of page)
     - yEndPct: Y-coordinate where question ends

3. "answers": object mapping question numbers to answer text from answer sheets
   Example: { "1": "B", "2": "A", "21a": "3/4" }. Empty object if no answer sheet.

## CRITICAL RULES for yStartPct / yEndPct:
- The crop MUST include the COMPLETE question — question number, all text, all diagrams, all answer options
- For MCQ: include the question stem AND all 4 answer options (A/B/C/D or 1/2/3/4)
- For structured questions: include everything from the question number down to where the next question starts
- Add 1-2% padding above and below for clean cropping
- No gaps between questions — yEndPct of Q(n) should approximately equal yStartPct of Q(n+1)
- Skip page headers (school name, page numbers) and footers
- If a question continues from a previous page, crop from the TOP of the page (yStartPct near 0)

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

const REDO_QUESTION_PROMPT = `You are re-analyzing a specific question from a Singapore school exam paper page.

I need you to find question "{questionNum}" on this page and provide precise boundaries for cropping.

Context about surrounding questions on this page:
{context}

Rules:
- Find question {questionNum} and provide its EXACT boundaries
- The crop MUST include the COMPLETE question: question number, all text, all diagrams, all answer options
- If it is an MCQ question, include the stem AND all answer options (A/B/C/D or 1/2/3/4)
- If it is a structured question with sub-parts (a, b, c), include ALL sub-parts
- Add 1-2% padding above and below
- yStartPct = 0 means top of page, yEndPct = 100 means bottom of page

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
