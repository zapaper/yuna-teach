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
- Whether the PDF contains MULTIPLE papers (e.g. Paper 1 and Paper 2). Look for:
  - Question numbers that RESET back to 1
  - A new cover page or header appearing mid-document
  - Labels like "Paper 2", "Booklet B", "Part 2"

## STEP 2: Read header instructions VERY carefully
The cover page or top of the first page contains critical metadata:
- School name, level (P1-P6, Sec 1-4), subject, year, exam type
- Total marks and duration
- Section breakdown with EXACT question count and marks per section
  e.g. "Section A: 28 questions x 1 mark = 28 marks", "Section B: 12 questions x 2 marks = 24 marks"
- This tells you EXACTLY how many questions to find in each section — use this as your guide
- Sometimes it says "Booklet A" (MCQ) and "Booklet B" (structured/written) — treat each booklet as a section
- If there are multiple papers in the PDF, each paper will have its OWN header — read each one

## STEP 3: Extract questions — ONE entry per question number

Every question is extracted the SAME way regardless of type (MCQ or written):
- TOP boundary = the question number (e.g. "1.", "24."), minus 2-3% padding
- BOTTOM boundary = just above the NEXT question number (e.g. "2.", "25."), minus 1%
- Each question is ONE entry — do NOT split sub-parts (a), (b), (c) into separate entries
- If question 24 has parts (a), (b), (c), it is still ONE entry: questionNum = "24"
- Include EVERYTHING between two consecutive question numbers: stem, sub-parts, answer options, diagrams, pictures, answer spaces, blank lines

### Sequential extraction rule:
- Extract questions in order: 1, 2, 3, 4...
- Use the PREVIOUS question's yEndPct to guide the NEXT question's yStartPct
  - Q1 yEndPct ≈ Q2 yStartPct (no gaps between questions)
- This means once you find Q1's boundaries, Q2's top is already known — you just need to find Q2's bottom (= top of Q3)

### MCQ questions:
- Each MCQ is a SEPARATE entry including stem + all answer options (A/B/C/D or 1/2/3/4)

### Written questions:
- Keep the ENTIRE question as ONE entry including ALL sub-parts (a), (b), (c) and answer spaces
- Written questions are larger — typically 15-50% of a page
- Include answer spaces ("Ans:" lines, answer boxes, blank working space)
- Include diagrams, pictures, graphs, tables, figures

## HANDLING MULTIPLE PAPERS IN ONE PDF
If the PDF contains multiple papers (Paper 1 + Paper 2, or Booklet A + Booklet B):
- Question numbers will RESET back to 1 when a new paper starts
- The PRINTED question numbers on Paper 2's pages are just "1", "2", "3" etc. — same as Paper 1
- For EXTRACTION, you look for the printed numbers "1", "2", "3" on the page — the same boundary rules apply
- Extract Paper 2 questions using the EXACT SAME method as Paper 1: find printed question numbers, use them as boundaries
- The ONLY difference is the questionNum in your JSON output gets a prefix to stay unique:
  - Paper 1: "1", "2", "3" (no prefix)
  - Paper 2: "P2-1", "P2-2", "P2-3" (prefix in output only)
- The prefix is ONLY for the JSON output — on the actual page, the question is still printed as "1", "2", etc.
- Each paper has its OWN header/instructions — read those to know how many questions to expect

## Validate question sequence WITHIN each paper
- Within a single paper, questions MUST be sequential: 1, 2, 3...
- If numbers jump (e.g. 5, 6, 10) you likely missed questions — look more carefully
- Each paper's numbering is independent

## STEP 4: Detect answer sheets
- Usually at the END of the document
- Titled "Answer Key", "Answers", or a table mapping question numbers to answers
- Mark these pages as isAnswerSheet: true
- Extract all answers, matching the question numbering format (e.g. "1", "22", "P2-1", "P2-3")

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
     - questionNum: e.g. "1", "2", "28", "29", "30", "P2-1", "P2-2", "P2-3"
     - yStartPct: Y-coordinate where question starts (0=top, 100=bottom)
     - yEndPct: Y-coordinate where question ends

3. "answers": object mapping question numbers to answer text
   Example: { "1": "B", "2": "A", "29": "3/4", "P2-1": "12", "P2-2": "5 cm" }

## CRITICAL RULES for yStartPct / yEndPct boundaries:

### The ONE rule for ALL questions (MCQ and written alike):
- yStartPct = top of this question's number (e.g. "5."), minus 2-3% padding
- yEndPct = top of the NEXT question's number (e.g. "6."), minus 1%
- EVERYTHING between two consecutive question numbers belongs to the first question

### Sequential guidance — use previous coordinates:
- Extract in order. Once you know Q(n)'s yEndPct, Q(n+1)'s yStartPct ≈ Q(n)'s yEndPct
- This eliminates gaps and helps you find the next question even if the number is hard to read
- On a new page: first question starts near the top (after any page header), last question extends to near the bottom (before footer)

### When you CANNOT clearly find a boundary:
- Cannot find TOP: use yEndPct of the previous question (no gaps rule)
- Cannot find BOTTOM: find the next question number you CAN see and use its top
- Cannot find next question at all: extend to just before the page footer (90-95%)
- NEVER output a tiny crop (less than 5% height) for a written question
- NEVER output invalid coordinates (yStartPct >= yEndPct)
- When in doubt, crop MORE — extra white space is better than cutting off content

### Edge cases:
- Question continues from previous page: yStartPct = 0 or 1
- Last question on page: yEndPct = just before footer/page number
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

const REDO_QUESTION_PROMPT = `Find question "{questionNum}" on this exam paper page and provide precise crop boundaries.

Context: {context}

## The ONE rule:
- yStartPct = top of question "{questionNum}" number on the page, minus 2-3% padding
- yEndPct = top of the NEXT question number, minus 1%
- EVERYTHING between two consecutive question numbers belongs to this question
- Include ALL content: stem, sub-parts (a)(b)(c), answer options, diagrams, pictures, answer spaces, blank lines

## Guidance:
- yStartPct = 0 means top of page, yEndPct = 100 means bottom of page
- If this is the last question on the page, extend yEndPct to just before the footer (90-95%)
- Written questions are large (15-50% of page) — do NOT output a tiny crop
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
