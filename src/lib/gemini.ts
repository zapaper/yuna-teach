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
- sections: array of sections with exact breakdown from the header
  e.g. "Section A: 28 questions x 1 mark = 28 marks" → {"name": "A", "type": "MCQ", "marks": 28, "questionCount": 28}

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
- sections: breakdown per section

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
    "school": "...", "level": "...", "subject": "...", "year": "...",
    "semester": "...", "title": "...", "totalMarks": "...",
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
      "sections": [{"name": "A", "type": "MCQ", "questionCount": 30}]
    },
    {
      "label": "Paper 1 Booklet B",
      "questionPrefix": "",
      "expectedQuestionCount": 14,
      "firstQuestionPageIndex": 10,
      "firstQuestionYStartPct": 8,
      "sections": [{"name": "B", "type": "structured", "questionCount": 14}]
    },
    {
      "label": "Paper 2",
      "questionPrefix": "P2-",
      "expectedQuestionCount": 6,
      "firstQuestionPageIndex": 19,
      "firstQuestionYStartPct": 12,
      "sections": [{"name": "", "type": "structured", "questionCount": 6}]
    }
  ]
}

If there is only one paper with no booklets, still include it in the "papers" array with questionPrefix "".
Return ONLY valid JSON.`;

// Stage 2a: Question Extraction — extract question boundaries from question pages only
const QUESTION_EXTRACTION_PROMPT = `You are an expert at extracting question boundaries from Singapore school exam papers.

You are given ONLY the question pages of the exam (answer sheets have been removed). Each image is labeled with its original page index (0-based).

## Context from structure analysis:
{structureContext}

## Your task: Extract EVERY question's crop boundaries

### The ONE rule for ALL questions (MCQ and written alike):
- yStartPct = top of this question's number (e.g. "5."), minus ~1% padding (just a tiny gap above)
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
- PAGE BOUNDARY: if Question N is the last on its page, yEndPct = ~95% (extend to near-bottom of that page). Question N+1 on the NEXT page starts at ~2-5% from the top
- If a question's content continues from the previous page with no question number at top, yStartPct = 0 or 1
- Never leave unexplained gaps — blank space between questions belongs to the preceding question's crop

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
- value: text description of the diagram/drawing, or empty string if purely visual. IMPORTANT: Do NOT use literal newlines inside JSON string values — use " | " as the separator instead.

### For "text" type answers:
- value: the FULL answer including all working steps. Transcribe EVERY line — do NOT skip or truncate. Use " | " to separate steps. Include sub-part labels if present.
- Examples:
  - MCQ (numbered): "(3)"
  - MCQ (lettered): "B"
  - Short answer: "15 cm"
  - Worked solution: "3/4 × 12 = 9 | 9 + 6 = 15 | Ans: 15 cm"
  - Sub-parts: "(a) 24 cm² | (b) 15 cm"
  - IMPORTANT: Do NOT use literal newlines — use " | " as separator

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "answers": {
    "1": {"type": "text", "value": "(3)"},
    "2": {"type": "text", "value": "(1)"},
    "29": {"type": "text", "value": "(a) 3/4 × 12 = 9 | (b) 9 + 6 = 15 | Ans: 15 cm"},
    "P2-1": {"type": "text", "value": "(a) Area = 1/2 × 8 × 6 = 24 cm² | (b) Perimeter = 8 + 6 + 10 = 24 cm"},
    "30": {"type": "image", "answerPageIndex": 8, "yStartPct": 45.0, "yEndPct": 55.0, "value": "triangle with height 6cm and base 8cm"}
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
  const nums: number[] = [];
  for (const page of result.pages) {
    for (const q of page.questions) {
      const raw = prefix ? q.questionNum.replace(prefix, "") : q.questionNum;
      const n = parseInt(raw, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums.sort((a, b) => a - b);
}

// Remap Gemini's returned pageIndex values back to original PDF page indices.
// Gemini Pro returns sequential 0-based indices (0, 1, 2...) for the images it
// received, ignoring the [Page N] labels. We map them back using originalPageIndices.
function remapPageIndices(
  result: QuestionExtractionResult,
  originalPageIndices: number[]
): QuestionExtractionResult {
  const origSet = new Set(originalPageIndices);
  return {
    ...result,
    pages: result.pages.map(page => {
      // If Gemini used the label correctly the index is already an original index
      if (origSet.has(page.pageIndex)) return page;
      // Otherwise treat as sequential position into originalPageIndices
      const remapped = originalPageIndices[page.pageIndex] ?? page.pageIndex;
      return { ...page, pageIndex: remapped };
    }),
  };
}

// Build a booklet-specific context string for per-booklet extraction
function buildBookletContext(paper: StructureResult["papers"][0], firstQuestionNum: number): string {
  const lines: string[] = [];
  lines.push(`Booklet: ${paper.label}`);
  lines.push(`Question prefix for JSON output: "${paper.questionPrefix}"`);
  lines.push(`Expected questions: ${paper.expectedQuestionCount} (starting from Q${firstQuestionNum})`);
  lines.push(`First question number to find: ${firstQuestionNum}`);
  for (const section of paper.sections) {
    lines.push(`Section ${section.name}: ${section.type}, ${section.questionCount} questions`);
  }
  return lines.join("\n");
}

// Stage 2a: Extract question boundaries for a SINGLE booklet — with validation + retry
async function extractQuestionsForBooklet(
  imagesBase64: string[],
  originalPageIndices: number[],
  paper: StructureResult["papers"][0],
  firstQuestionNum: number
): Promise<QuestionExtractionResult> {
  const imageParts = imagesBase64.map((data, i) => [
    { inlineData: { mimeType: "image/jpeg" as const, data } },
    { text: `[Page ${originalPageIndices[i]}]` },
  ]).flat();

  const bookletContext = buildBookletContext(paper, firstQuestionNum);
  const prompt = QUESTION_EXTRACTION_PROMPT.replace(
    "{structureContext}",
    bookletContext
  );

  // First attempt — use Pro model for better visual reasoning on question boundaries
  const response = await getAI().models.generateContent({
    model: "gemini-2.5-pro",
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
  if (!text) throw new Error(`Gemini returned empty response for question extraction (${paper.label})`);
  console.log(`[Exam Pipeline] ${paper.label} raw response (first 300 chars):`, text.slice(0, 300));
  let pages: QuestionExtractionResult["pages"] = [];
  try {
    const parsed = JSON.parse(sanitizeJsonString(text));
    // Normalize: handle top-level array, nested result, or missing pages
    let rawPages = parsed.pages ?? parsed.result?.pages ?? parsed.data?.pages;
    if (!Array.isArray(rawPages) && Array.isArray(parsed)) rawPages = parsed;
    if (!Array.isArray(rawPages)) {
      console.log(`[Exam Pipeline] ${paper.label}: unexpected structure, keys: ${Object.keys(parsed).join(", ")}, raw: ${text.slice(0, 500)}`);
      rawPages = [];
    }
    pages = rawPages;
  } catch (parseErr) {
    console.log(`[Exam Pipeline] ${paper.label}: JSON parse failed (truncated response?), will retry. Error: ${parseErr}`);
    // pages stays []
  }
  const result: QuestionExtractionResult = {
    ...remapPageIndices({ pages }, originalPageIndices),
    _rawSnippet: text.slice(0, 400),
  };

  // Validate: check first question is correct
  const allQNums = extractQuestionNumbers(result, paper.questionPrefix);

  const issues: string[] = [];
  if (allQNums.length === 0) {
    issues.push(`No questions detected at all (expected ~${paper.expectedQuestionCount} starting from Q${firstQuestionNum})`);
  } else {
    // Check first question
    if (allQNums[0] !== firstQuestionNum) {
      issues.push(`First question should be ${firstQuestionNum} but got ${allQNums[0]}`);
    }
    // Check for gaps
    const gaps: number[] = [];
    for (let i = 1; i < allQNums.length; i++) {
      for (let g = allQNums[i - 1] + 1; g < allQNums[i]; g++) {
        gaps.push(g);
      }
    }
    if (gaps.length > 0) {
      issues.push(`Missing questions: ${gaps.join(", ")}`);
    }
    // Check for duplicates
    const seen = new Set<number>();
    for (const n of allQNums) {
      if (seen.has(n)) issues.push(`Duplicate question: ${n}`);
      seen.add(n);
    }
  }

  if (issues.length === 0) {
    console.log(`[Exam Pipeline] ${paper.label} extraction OK: Q${allQNums[0]}-Q${allQNums[allQNums.length - 1]} (${allQNums.length} questions)`);
    return result;
  }

  // Retry with feedback
  console.log(`[Exam Pipeline] ${paper.label} issues, retrying:`, issues);

  const retryFeedback = `
## Your previous extraction for ${paper.label} had these problems:
${issues.map(i => `- ${i}`).join("\n")}

Re-examine the pages carefully:
- The FIRST question on these pages should be "${paper.questionPrefix}${firstQuestionNum}" — find it at the LEFT MARGIN
- If you cannot find "${firstQuestionNum}." at the left margin of the first page, the first page might be a cover/instruction page — skip it and look at the NEXT page
- Scan every page carefully for question numbers at the LEFT MARGIN
- Do NOT skip any question numbers in the sequence
- Keep ALL boundary coordinates (yStartPct, yEndPct) accurate — do NOT sacrifice crop quality

CRITICAL: Keep ALL boundary coordinates (yStartPct, yEndPct) accurate. Do NOT sacrifice boundary quality to fix the gaps. Each question's crop must still be tight and correct.
`;

  const retryResponse = await getAI().models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: prompt }],
      },
      {
        role: "model",
        parts: [{ text: text }],
      },
      {
        role: "user",
        parts: [{ text: retryFeedback }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const retryText = retryResponse.text;
  if (!retryText) {
    console.log(`[Exam Pipeline] ${paper.label} retry empty, using first attempt`);
    return result;
  }

  let retryPages: QuestionExtractionResult["pages"] = [];
  try {
    const retryParsed = JSON.parse(sanitizeJsonString(retryText));
    let rawRetryPages = retryParsed.pages ?? retryParsed.result?.pages ?? retryParsed.data?.pages;
    if (!Array.isArray(rawRetryPages) && Array.isArray(retryParsed)) rawRetryPages = retryParsed;
    if (!Array.isArray(rawRetryPages)) rawRetryPages = [];
    retryPages = rawRetryPages;
  } catch (retryParseErr) {
    console.log(`[Exam Pipeline] ${paper.label}: retry JSON parse failed (truncated response?), using first attempt. Error: ${retryParseErr}`);
    return result;
  }
  const retryResult: QuestionExtractionResult = {
    ...remapPageIndices({ pages: retryPages }, originalPageIndices),
    _rawSnippet: retryText.slice(0, 400),
  };
  const retryQNums = extractQuestionNumbers(retryResult, paper.questionPrefix);
  console.log(`[Exam Pipeline] ${paper.label} retry: Q${retryQNums[0] ?? "?"}-Q${retryQNums[retryQNums.length - 1] ?? "?"} (${retryQNums.length} questions)`);

  return retryResult;
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
  if (!text) {
    console.log("[Exam Pipeline] Answer extraction: empty response, returning empty answers");
    return { answers: {} };
  }
  try {
    return JSON.parse(sanitizeJsonString(text)) as AnswerExtractionResult;
  } catch (parseErr) {
    console.log(`[Exam Pipeline] Answer extraction: JSON parse failed (truncated response?). Raw snippet: ${text.slice(0, 300)}. Error: ${parseErr}`);
    return { answers: {} };
  }
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
    }>;
  }>;
  answers: Record<string, AnswerEntry>;
  _debug?: {
    papers: Array<{
      label: string;
      questionsStartPage: number;
      questionsStartY: number;
      expectedQuestions: number;
    }>;
    coverPages: number[];
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

  for (let i = 0; i < sortedPapers.length; i++) {
    const paper = sortedPapers[i];
    // If firstQuestionPageIndex itself is a cover page (structure analysis off-by-1),
    // advance to the next non-cover page
    const coverSet = new Set(coverPageEntries.map(p => p.pageIndex));
    let startPage = paper.firstQuestionPageIndex;
    while (coverSet.has(startPage) && startPage <= maxNonAnswerPage) startPage++;

    const endPage = i < sortedPapers.length - 1
      ? sortedPapers[i + 1].firstQuestionPageIndex - 1
      : maxNonAnswerPage;

    // Collect question pages in this range — exclude answer sheets AND cover pages
    // Cover pages must never be sent to question extraction (the AI hallucinates questions on them)
    const pageIndices = structure.pages
      .filter(p => p.pageIndex >= startPage && p.pageIndex <= endPage && !p.isAnswerSheet && !p.isCoverPage)
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
  })));

  // --- Stage 2a: Extract questions per booklet (concurrent) + Stage 2b: Answers ---
  const answerImages = answerPageEntries.map(p => imagesBase64[p.pageIndex]);
  const answerPageIndices = answerPageEntries.map(p => p.pageIndex);

  const [bookletResults, answerResult] = await Promise.all([
    // All booklet extractions run concurrently
    Promise.all(bookletPageRanges.map(({ paper, pageIndices, firstQuestionNum }) => {
      if (pageIndices.length === 0) return Promise.resolve({ pages: [] } as QuestionExtractionResult);
      const images = pageIndices.map(idx => imagesBase64[idx]);
      return extractQuestionsForBooklet(images, pageIndices, paper, firstQuestionNum);
    })),
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
  console.log("[Exam Pipeline] Question extraction:", JSON.stringify(
    questionResult.pages.map(p => ({ idx: p.pageIndex, questions: p.questions.map(q => q.questionNum) }))
  ));
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

  return {
    header: structure.header,
    pages,
    answers: answerResult.answers,
    _debug: {
      papers: structure.papers.map(p => ({
        label: p.label,
        questionsStartPage: p.firstQuestionPageIndex + 1, // 1-based for easy PDF comparison
        questionsStartY: p.firstQuestionYStartPct,
        expectedQuestions: p.expectedQuestionCount,
      })),
      coverPages: coverPageEntries.map(p => p.pageIndex + 1), // 1-based
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

const REDO_QUESTION_PROMPT = `Find question "{questionNum}" on this exam paper page and provide precise crop boundaries.

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
- value: text description of the visual content

## Return format:
For text: { "type": "text", "value": "B" }
For worked text: { "type": "text", "value": "(a) 3/4 × 12 = 9 | (b) 9 + 6 = 15 | Ans: 15 cm" }
For image: { "type": "image", "yStartPct": 45.0, "yEndPct": 55.0, "value": "diagram of triangle" }

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
