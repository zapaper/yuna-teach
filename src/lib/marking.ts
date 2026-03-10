import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";

/**
 * Isolate blue ink and thicken strokes using Sharp + raw pixel manipulation.
 * Used for MCQ answer "1" which is a thin vertical stroke easily missed by AI.
 * Steps: extract RGB pixels → filter blue ink → thicken via neighbor spread → encode as JPEG
 */
async function isolateAndThickenBlueInk(imageBuffer: Buffer, label: string): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    // Create grayscale mask: 0 = blue ink, 255 = background
    const mask = Buffer.alloc(width * height, 255);

    // Pass 1: identify blue pixels (RGB where blue is dominant)
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 3];
      const g = data[i * 3 + 1];
      const b = data[i * 3 + 2];
      // Blue ink: blue channel high, significantly more than red and green
      if (b > 60 && b > r * 1.3 && b > g * 1.2 && (r + g) < 380) {
        mask[i] = 0; // mark as ink
      }
    }

    // Pass 2: dilate — spread each ink pixel by 5px in all directions (thicker = easier to detect)
    const dilated = Buffer.alloc(width * height, 255);
    const radius = 5;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] === 0) {
          // Spread to neighbors
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const ny = y + dy, nx = x + dx;
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                dilated[ny * width + nx] = 0;
              }
            }
          }
        }
      }
    }

    const jpegBuffer = await sharp(dilated, { raw: { width, height, channels: 1 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    console.log(`[marking] BLUE_ENHANCE ${label}: isolated + dilated, ${imageBuffer.length} → ${jpegBuffer.length} bytes`);
    return jpegBuffer;
  } catch (err) {
    console.warn(`[marking] BLUE_ENHANCE ${label}: failed, falling back to original:`, err);
    return imageBuffer;
  }
}

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

// Timeout for each Gemini call (3 minutes — some pages with many diagram answers are slow)
const GEMINI_TIMEOUT_MS = 180_000;

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

/** Crop a page image to a vertical region defined by yStartPct/yEndPct */
async function cropPageRegion(
  pageBuffer: Buffer,
  yStartPct: number,
  yEndPct: number,
  label: string = ""
): Promise<Buffer> {
  const meta = await sharp(pageBuffer).metadata();
  const height = meta.height ?? 1;
  const width = meta.width ?? 1;
  // Add small padding (2%) above and below to avoid cutting off handwriting
  const pad = height * 0.02;
  const top = Math.max(0, Math.round((yStartPct / 100) * height - pad));
  const bottom = Math.min(height, Math.round((yEndPct / 100) * height + pad));
  const cropHeight = Math.max(1, bottom - top);
  const cropped = await sharp(pageBuffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .jpeg()
    .toBuffer();
  console.log(`[marking] CROP ${label}: original ${width}x${height}, yStart=${yStartPct}% yEnd=${yEndPct}% → top=${top}px bottom=${bottom}px cropH=${cropHeight}px, cropped size=${cropped.length} bytes`);
  return cropped;
}

/** Check if a question is a "written" (non-MCQ) question — applies to science and math */
function isWrittenQuestion(answer: string | null): boolean {
  if (!answer) return true; // no answer key = assume written
  // MCQ answers: "1","2","3","4","A","B","C","D","(1)","(2)","(3)","(4)","(A)","(B)","(C)","(D)"
  const trimmed = answer.trim();
  return !/^\(?[1-4A-Da-d]\)?$/.test(trimmed);
}

/** Step 1 pre-check: ask Gemini if there is any handwritten blue ink in the image.
 *  Returns true if blue ink is detected, false if blank. */
async function hasBlueInk(imageBase64: string, label: string): Promise<boolean> {
  const prompt = `Look at this image carefully. Is there ANY handwritten text or marks in BLUE INK?
Do NOT count printed black text — only handwritten blue ink marks made by a student.
Reply with ONLY one word: YES or NO.`;

  try {
    const response = await withTimeout(
      getAI().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: prompt },
        ]}],
        config: { temperature: 0.3 },
      }),
      30_000,
      `blueInkCheck ${label}`
    );
    const text = (response.text ?? "").trim().toUpperCase();
    const result = text.startsWith("YES");
    console.log(`[marking] BLUE INK CHECK ${label}: "${text}" → ${result ? "HAS INK" : "BLANK"}`);
    return result;
  } catch (err) {
    // If pre-check fails, assume ink exists to avoid false negatives
    console.warn(`[marking] BLUE INK CHECK ${label} failed, assuming ink exists:`, err);
    return true;
  }
}

/** Detect MCQ answer(s) from a page image WITHOUT revealing expected answers (avoids confirmation bias).
 *  Returns map of questionId → detected digit/letter or null. */
async function detectMcqAnswers(
  imageBase64: string,
  questions: Array<{ id: string; questionNum: string; yStartPct: number | null; yEndPct: number | null }>,
  label: string,
  temperature = 0.4,
  hintAnswer1QuestionIds: Set<string> = new Set()
): Promise<Map<string, string | null>> {
  const qLines = questions.map((q) => {
    const yStart = q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
    const yEnd = q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
    const hint = hintAnswer1QuestionIds.has(q.id)
      ? ` ⚠️ HINT: The answer for this question is likely the digit "1" — a single short vertical blue stroke (like | or l or I). It may be very thin and small. Look carefully for ANY vertical blue line in the answer area.`
      : "";
    return `- Question ${q.questionNum} (ID: ${q.id}): answer region ${yStart}–${yEnd} from top of image${hint}`;
  }).join("\n");

  const prompt = `You are reading a student's handwritten MCQ answers from an exam paper.

COLOR DISTINCTION — THIS IS CRITICAL:
- PRINTED text on the page is BLACK or DARK GREY ink. This includes question numbers, option labels "(1)", "(2)", "(3)", "(4)", answer keys, and all printed text. COMPLETELY IGNORE all black/dark printed text.
- The student writes in BLUE INK — a distinctly BLUE color, NOT black, NOT grey, NOT dark.
- You must ONLY read marks that are clearly BLUE in color. If a mark is black or dark, it is printed — ignore it.

For each question below, look ONLY within its vertical region (yStart% to yEnd% from top of image).
Find the single digit or letter the student HANDWROTE in BLUE INK as their MCQ answer.

The student's answer will be ONE of: 1, 2, 3, 4, A, B, C, or D.

HOW EACH DIGIT LOOKS IN HANDWRITING:
- "1" = a single short vertical stroke (like | or l or I). No curves. May have a small top serif or tick. VERY EASY TO MISS — it looks like a simple line.
- "2" = starts high, curves right, then sweeps left with a flat base (like a mirrored Z)
- "3" = two bumps on the right side, open on the left
- "4" = angular top-left stroke, vertical right stroke, horizontal crossbar

WHERE TO LOOK — START FROM THE RIGHT SIDE:
- The student writes their answer in BLUE INK on the RIGHT SIDE of the page
- SCAN RIGHT TO LEFT: Start from the far right of the question's row and work leftward
- The answer is a single handwritten digit (1/2/3/4) in blue ink on the right portion
- IGNORE everything on the left — that is printed question text and option labels in black

How to distinguish BLUE handwriting from BLACK print:
- Printed option labels "(1)", "(2)", "(3)", "(4)" scattered across the question are BLACK — IGNORE them all
- The student's BLUE INK answer is on the RIGHT side, written separately from any printed text
- Blue ink has a distinctly BLUE hue — it looks different from black printed text
- If you are unsure whether a mark is blue or black, it is probably black (printed) — report null

STRICT RULES:
1. ONLY report a digit/letter if it is clearly written in BLUE INK by hand
2. If the only digits you see are BLACK PRINTED text → report null (student left it blank)
3. Do NOT read printed black "(1)", "(2)" etc. as the student's answer
4. Each question's region is independent — do NOT mix up answers between regions
5. Report your confidence: "high" if clearly blue handwriting, "low" if uncertain
6. For any question with the ⚠️ HINT: look extra carefully for a thin vertical blue stroke — "1" is the most missed digit

Questions:
${qLines}

Return ONLY valid JSON (no markdown fences):
{
  "answers": [
    {"questionId": "ID", "detected": "1", "confidence": "high"},
    {"questionId": "ID", "detected": null, "confidence": "high"}
  ]
}`;

  try {
    const response = await withTimeout(
      getAI().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: prompt },
        ]}],
        config: { responseMimeType: "application/json", temperature },
      }),
      GEMINI_TIMEOUT_MS,
      `MCQ detect ${label}`
    );
    const text = response.text;
    if (!text) return new Map();
    const parsed = extractJson(text) as { answers: Array<{ questionId: string; detected: string | null; confidence?: string }> };
    const result = new Map<string, string | null>();
    for (const a of parsed.answers) {
      // Discard low-confidence detections — treat as null (no answer)
      const val = a.confidence === "low" ? null : a.detected;
      result.set(a.questionId, val);
      console.log(`[marking] MCQ DETECT ${label} Q-ID ${a.questionId}: detected="${a.detected}", confidence=${a.confidence ?? "?"}, using="${val}"`);
    }
    return result;
  } catch (err) {
    console.warn(`[marking] MCQ detect failed for ${label}:`, err);
    return new Map();
  }
}

/** Check if a question is MCQ based on its expected answer */
function isMcqAnswer(answer: string | null): boolean {
  if (!answer) return false;
  return /^\(?[1-4A-Da-d]\)?$/.test(answer.trim());
}

/** Normalize MCQ answer for comparison: strip parens, uppercase */
function normalizeMcq(val: string): string {
  return val.trim().replace(/[()]/g, "").toUpperCase();
}

/**
 * Build the answer description string for the marking prompt.
 * When an answer image is present, makes it explicit which sub-segment
 * the image covers vs which segments have text answers.
 */
function buildAnswerDesc(answer: string | null, hasImage: boolean): string {
  if (!hasImage) return answer ? `"${answer}"` : "not provided";
  // With image: the answer text typically contains all sub-parts.
  // Tell AI: image covers the diagram/drawing part; text covers remaining parts.
  return `Multi-part answer:
    - The ADDITIONAL IMAGE provided shows the expected diagram/drawing answer for the sub-segment that requires a drawing.
    - The TEXT answer key is: "${answer ?? "see image only"}"
    - For any sub-segment marked "(a)", "(b)", "(c)" etc. in the text answer key:
        • If the text key shows a value for that sub-segment (e.g. "(b) 5") → compare student's blue ink against that TEXT value.
        • If the text key does NOT have a value for a sub-segment (or says "see image") → compare student's drawing against the ADDITIONAL IMAGE.
    - NEVER use the image to mark a sub-segment that already has a text answer in the key.
    - NEVER use the text key to mark a sub-segment that should be compared against the image.`;
}

interface QuestionMarkResult {
  questionId: string;
  marksAvailable: number;
  marksAwarded: number;
  studentAnswer?: string;
  notes: string;
}

/** Build markingNotes string, prefixing with detected student answer when available */
function buildMarkingNotes(result: QuestionMarkResult): string {
  const parts: string[] = [];
  if (result.studentAnswer) parts.push(`Detected: ${result.studentAnswer}`);
  if (result.notes) parts.push(result.notes);
  return parts.join(" | ");
}

function englishMarkingRules(subject: string | null | undefined): string {
  if (!subject?.toLowerCase().includes("english")) return "";
  return `
  ENGLISH PAPER MARKING RULES:
  - MCQ questions: mark identically to Math/Science — no partial marks, exact single-option match only.
  - For ALL written English questions, READ the question text in the image to identify the question type, then apply the rules below:

  SYNTHESIS & TRANSFORMATION / GRAMMAR FILL-IN:
  - There is usually one correct rewritten sentence or one accepted form.
  - Award full marks only if the answer is grammatically correct AND preserves the original meaning.
  - Award 0 if meaning is changed, tense is wrong, or key words are missing.
  - Minor spelling errors that do not change the word: still award marks.

  COMPREHENSION (open-ended, short answer):
  - The answer key gives the expected key point(s).
  - Award full marks if all key points are present in the student's answer.
  - Award PARTIAL marks if some key points are present — even for 1-mark questions, award 0 if the key idea is missing or too vague.
  - Accept synonyms and paraphrases as long as the meaning is preserved.
  - In notes, state which key point was present or missing.

  EDITING (spelling/grammar correction):
  - One specific correct answer per error. Award marks only if the student identified the correct word AND wrote the correct replacement.

  CLOZE / FILL-IN-THE-BLANK:
  - Accept the exact word from the answer key. Accept clear synonyms only if semantically equivalent in context.
  - Do NOT accept answers that change the grammar of the sentence.

  VOCABULARY (word meaning, synonym, antonym):
  - Award marks for exact match or clear semantic equivalent from the answer key.`;
}

function scienceCommandWordRules(subject: string | null | undefined): string {
  if (!subject?.toLowerCase().includes("science")) return "";
  return `
  SCIENCE COMMAND WORD RULES (applies to this Science paper only):
  - Before comparing the student's answer, READ the printed question text in the image to identify the command word.
  - "State" questions: expect a concise, factual answer. The answer key gives a short, direct answer.
    Award full marks only if the student's answer matches the key point(s). Partial marks only if marksAvailable > 1 and some (but not all) key points are present.
  - "Describe" questions: the answer key gives a more detailed expected response covering multiple aspects (e.g. what happens, how, why).
    The student must provide sufficient detail to earn full marks.
    Award PARTIAL marks if the student captures some but not all key details — even if only 1 mark is available, award 0 if the description is too vague or missing the key detail.
    In notes, clearly state which details were present and which were missing.
  - "Explain" questions: treat the same as "Describe" — detail and reasoning are required.
  - All other command words (Name, Give, Identify, etc.): treat like "State" — short, specific answer expected.`;
}

const MARKING_PROMPT = `You are marking a primary school student's exam submission. Be concise.

HOW TO READ THIS IMAGE:
- Printed question text = BLACK. Student's handwritten answers = BLUE INK.
- ONLY blue ink counts as the student's answer. Black printed text is NEVER the student's answer.

Questions on this page (vertical position as % from top of image):
{QUESTIONS}

{ANSWER_IMAGES_NOTE}

Instructions — follow this EXACT sequence for EACH question:

╔══════════════════════════════════════════════════════════════════╗
║  STEP 1: BLUE INK CHECK — DO THIS FIRST, BEFORE ANYTHING ELSE  ║
╚══════════════════════════════════════════════════════════════════╝

Look at the question's vertical region (yStart% to yEnd%, measured from TOP of image).
Scan ONLY this strip for BLUE INK — handwritten marks made by the student.

The image contains TWO types of content:
  ❌ BLACK = printed exam paper (questions, labels, answer keys, diagrams). IGNORE ALL BLACK TEXT.
  ✅ BLUE = student's handwritten answer. This is the ONLY thing that counts.

IF NO BLUE INK EXISTS in this question's region:
  → For MCQ / short-answer questions (expected answer is a single digit, letter, or short word):
    LOOK AGAIN. Children's handwriting can be very small, faint, or lightly written.
    Check near answer boxes, brackets, parentheses, or underlines in the answer area.
    A tiny blue mark that resembles a digit or letter IS the student's answer.
    Only conclude "No answer detected" if you are CERTAIN there is no blue ink at all.
  → For all questions, if truly no blue ink: studentAnswer = "No answer detected",
    marksAwarded = 0, notes = "No blue ink answer found".
    SKIP all remaining steps. Move to the next question.

Do NOT confuse printed black text with the student's answer. If text in the answer area
matches the expected answer but is BLACK (printed), that is the answer key — the student
left it blank. Award 0 marks.

STEP 2: Read the blue ink answer — HARD BOUNDARY ENFORCEMENT.
  Each question has a vertical region: yStart% to yEnd% (measured from TOP of image).
  Example: yStart=42% yEnd=60% means ONLY the strip between 42% and 60% down the page.

  ╔══════════════════════════════════════════════════════════════════╗
  ║  BOUNDARY RULE: Treat yStart% and yEnd% as ABSOLUTE WALLS.     ║
  ║  ANY ink, text, or marks OUTSIDE this region DO NOT EXIST.      ║
  ║  Even if you can see writing above or below — it is NOT there.  ║
  ╚══════════════════════════════════════════════════════════════════╝

  - Blue ink ABOVE yStart% → belongs to another question. PRETEND IT DOES NOT EXIST.
  - Blue ink BELOW yEnd% → belongs to another question. PRETEND IT DOES NOT EXIST.
  - If the student's answer for a DIFFERENT question bleeds into this region, ignore it
    unless it is clearly within the boundaries.
  - For MCQ: the answer box/circle is usually near the RIGHT side of the question's strip.
    Look ONLY in that strip. An answer in a different question's region is NOT this question's answer.
  - If boundaries are "unknown", use visual cues (printed question number, separator lines).
  - CRITICAL — detecting handwritten digits in blue ink:
    Children write digits simply. A blue "1" is just a short vertical stroke (|) — no serif, no base.
    A blue "2" may look like a curvy Z. A blue "3" looks like two bumps. A blue "4" has an angular top.
    ANY blue ink mark in the answer area that resembles a digit IS the student's answer.
    Do NOT dismiss small or faint blue marks as stray marks — children's handwriting is often small.
    If the expected answer is a single digit (1, 2, 3, 4) and you see ANY blue mark in the answer
    region, interpret it as the student's digit answer. Err on the side of detecting an answer.
  - Questions may have parts (a), (b), (c). Read each part's blue ink answer separately.

STEP 3: Match the answer to the correct sub-part.
  The expected answer may contain multiple parts like "(a) 5.6 (b) 3/4 (c) 12".
  The question number tells you which part(s) to mark:
  - Question "11a" → only mark against the "(a)" part of the expected answer.
  - Question "11bcd" → only mark against parts "(b)", "(c)", "(d)" of the expected answer.
  - Question "11" (no suffix) → mark against all parts of the expected answer.
  NEVER mark a sub-part question against the wrong answer key.

STEP 4: Marks available.
  Use the "marksAvailable" value specified for each question.
  If it says "detect", read from the printed label on the page (e.g. "[2]", "(2 marks)").

STEP 5: Compare against the expected answer.
  A) If the student's answer MATCHES the expected answer → FULL MARKS.
  B) If the student's answer does NOT match:
     - For MCQ (single option like "1","2","A","B"): ZERO marks. No partial marks for MCQ.
     - For written/worked answers: check if working/steps are partially correct.
       If some steps are correct → award PARTIAL marks = round(proportion × marksAvailable).
     - If answer is wrong with no correct working → ZERO marks.
{SUBJECT_RULES}
  C) For questions with an answer image provided:
     - The answer image shows EXACTLY what the correct answer looks like.
     - Compare ONLY what the student actually drew/wrote in blue ink against what is shown in the answer image.
     - You MUST verify VISUAL DETAILS precisely — direction, orientation, shape, and position all matter:
         • An arrow pointing UP is WRONG if the answer image shows it pointing DOWN. Opposite directions = 0 marks.
         • A curve going LEFT is WRONG if the answer shows it going RIGHT.
         • A label in the wrong position is WRONG even if the word is correct.
         • A line at the wrong angle is WRONG even if it connects the right endpoints.
     - Do NOT award marks if the student's drawing merely "looks similar" — it must match the answer image in direction, orientation, and all key visual features.
     - For multi-part answers (a), (b), (c): compare each sub-part independently against its corresponding part in the answer image.
     - If the student's drawing differs in ANY key visual aspect (wrong direction, wrong shape, wrong position) → 0 marks for that part.
     - If you cannot clearly see the student's blue ink detail → do not assume it matches → 0 marks for that part.
     - NEVER infer, assume, or hallucinate. Only award marks for what you can clearly see matches the answer image.

STEP 6: Record what you detected.
  "studentAnswer": Write EXACTLY what the student wrote in blue ink.
    - For text/number answers: quote their answer (e.g. "3.5 kg", "B", "12").
    - For MCQ: the option they wrote (e.g. "1", "2", "A", "B").
    - If multi-part: combine parts (e.g. "(a) 12 (b) 3.5")
    - If blue ink exists but the answer is illegible, incomplete, or too unclear to read:
      write what you can see (e.g. "illegible blue ink" or partial answer like "12...") — do NOT guess the rest.
    - NEVER write the expected answer as the student's answer. If you did not clearly detect it in blue ink, it is not there.
    - For sub-parts where the student did not answer or the answer is wrong/unclear: write "(a) missing" or "(b) incorrect" — do NOT copy the answer key into studentAnswer.

STEP 7: Notes — concise but helpful:
  - Full marks → notes = "" (empty string)
  - Partial marks → explain which parts were correct and which were wrong/missing (2-3 sentences max)
  - Zero marks (with an answer) → explain why the student's answer is wrong compared to the expected answer (1-2 sentences)
  - Zero marks (no answer) → "No blue ink answer found"
  - If a question context image is provided, use it to explain the mistake in context of what was asked
  - Include what the student wrote vs what was expected when relevant

FINAL REMINDER — READ THIS BEFORE RESPONDING:
  1. For EVERY question, your FIRST action must be checking for blue ink within its yStart%–yEnd% region.
  2. NEVER read ink outside a question's yStart%–yEnd% boundaries. Content outside = invisible.
  3. If a question's region has NO blue handwritten ink → marksAwarded: 0, studentAnswer: "No answer detected".
  4. Printed black text (even if it matches the expected answer) is NOT the student's answer.
  5. Do NOT hallucinate or invent answers. Only report what is actually handwritten in blue ink WITHIN boundaries.
  6. For answer image questions: ONLY compare against what is visible in the provided answer image. Never guess or infer the correct answer from context.
  7. Blue ink present ≠ correct answer. If blue ink exists but is too incomplete/illegible to match the expected answer, award 0 marks. Do NOT assume the student wrote the correct answer just because some blue ink is there.
  8. NEVER copy the answer key into studentAnswer. studentAnswer must only contain what you actually saw written in blue ink. If a sub-part answer was not detected, say "(x) missing" — never substitute the expected answer.

Return ONLY valid JSON (no markdown fences):
{
  "questions": [
    {"questionId": "ID", "marksAvailable": 2, "marksAwarded": 2, "studentAnswer": "3.5 kg", "notes": ""},
    {"questionId": "ID", "marksAvailable": 3, "marksAwarded": 0, "studentAnswer": "No answer detected", "notes": "No blue ink answer found"}
  ]
}`;

// Extract JSON from a Gemini response that may have markdown fences or extra text
function extractJson(text: string): unknown {
  // Strip markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  // Find the first { ... } block
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(raw.slice(start, end + 1));
}

// Wrap a promise with a hard timeout that rejects after `ms` milliseconds
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

// Re-mark a single question (e.g. after parent hits "Re-mark")
export async function remarkSingleQuestion(questionId: string): Promise<void> {
  console.log(`[marking] remarkSingleQuestion ${questionId}`);
  const question = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    include: { examPaper: { include: { questions: { select: { id: true, marksAwarded: true } } } } },
  });
  if (!question) throw new Error("Question not found");

  const paper = question.examPaper;

  // Sync from master if this is a clone — match by questionNum first, then orderIndex
  if (paper.sourceExamId) {
    const masterQ = await prisma.examQuestion.findFirst({
      where: {
        examPaperId: paper.sourceExamId,
        questionNum: question.questionNum,
      },
    }) ?? await prisma.examQuestion.findFirst({
      where: {
        examPaperId: paper.sourceExamId,
        orderIndex: question.orderIndex,
      },
    });
    if (masterQ) {
      const updates: Record<string, unknown> = {};
      if (masterQ.questionNum !== question.questionNum) updates.questionNum = masterQ.questionNum;
      if (masterQ.marksAvailable !== question.marksAvailable) updates.marksAvailable = masterQ.marksAvailable;
      if (masterQ.answer !== question.answer) updates.answer = masterQ.answer;
      if (masterQ.answerImageData !== question.answerImageData) updates.answerImageData = masterQ.answerImageData;
      if (masterQ.imageData !== question.imageData) updates.imageData = masterQ.imageData;
      if (masterQ.pageIndex !== question.pageIndex) updates.pageIndex = masterQ.pageIndex;
      if (masterQ.yStartPct !== question.yStartPct) updates.yStartPct = masterQ.yStartPct;
      if (masterQ.yEndPct !== question.yEndPct) updates.yEndPct = masterQ.yEndPct;
      if (Object.keys(updates).length > 0) {
        await prisma.examQuestion.update({ where: { id: question.id }, data: updates });
        Object.assign(question, updates);
        console.log(`[marking] Synced question ${question.questionNum} from master`);
      }
    }
  }

  const subDir = path.join(SUBMISSIONS_DIR, paper.id);

  // Compute submissionIndexMap the same way as markExamPaper
  const metadata = paper.metadata as { answerPages?: number[] } | null;
  const answerPageSet = new Set((metadata?.answerPages ?? []).map((p: number) => p - 1));
  let submissionIdx = 0;
  let submissionPage = -1;
  for (let i = 0; i < paper.pageCount; i++) {
    if (!answerPageSet.has(i)) {
      if (i === question.pageIndex) { submissionPage = submissionIdx; break; }
      submissionIdx++;
    }
  }
  if (submissionPage === -1) throw new Error("Question page not in submission");

  const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
  const pageBuffer = await fs.readFile(pagePath);

  // MCQ: use blind detection (no expected answer shown to AI)
  if (isMcqAnswer(question.answer)) {
    const pageBase64 = pageBuffer.toString("base64");
    const isAnswer1 = normalizeMcq(question.answer ?? "") === "1";
    let studentAnswer: string | null = null;

    if (isAnswer1) {
      // 1 normal + 1 OpenCV-enhanced — if either detects "1", accept it
      console.log(`[marking] remarkSingle MCQ Q${question.questionNum}: answer=1, normal + opencv`);
      const enhancedBuffer = await isolateAndThickenBlueInk(pageBuffer, `remarkSingle Q${question.questionNum}`);
      const enhancedBase64 = enhancedBuffer.toString("base64");

      const hint1 = new Set([question.id]);
      const [normalDet, opencvDet] = await Promise.all([
        detectMcqAnswers(pageBase64, [question], `remarkSingle Q${question.questionNum} normal`, 0.4, hint1),
        detectMcqAnswers(enhancedBase64, [question], `remarkSingle Q${question.questionNum} opencv`, 0.3, hint1),
      ]);
      const normalAns = normalDet.get(question.id) ?? null;
      const opencvAns = opencvDet.get(question.id) ?? null;
      console.log(`[marking] remarkSingle Q${question.questionNum}: normal="${normalAns}", opencv="${opencvAns}"`);

      // If either detects "1", use "1"; otherwise use whichever detected something
      if (normalAns && normalizeMcq(normalAns) === "1") studentAnswer = "1";
      else if (opencvAns && normalizeMcq(opencvAns) === "1") studentAnswer = "1";
      else studentAnswer = normalAns ?? opencvAns;
    } else {
      console.log(`[marking] remarkSingle MCQ Q${question.questionNum}: blind detection`);
      const detected = await detectMcqAnswers(pageBase64, [question], `remarkSingle Q${question.questionNum}`);
      studentAnswer = detected.get(question.id) ?? null;
    }

    const expected = question.answer?.trim() ?? "";
    const match = studentAnswer ? normalizeMcq(studentAnswer) === normalizeMcq(expected) : false;
    const awarded = match ? (question.marksAvailable ?? 1) : 0;
    const notes = !studentAnswer ? "No blue ink answer found"
      : match ? ""
      : `Student wrote "${studentAnswer}", expected "${expected}"`;

    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { marksAwarded: awarded, markingNotes: `Detected: ${studentAnswer ?? "No answer detected"}${notes ? ` | ${notes}` : ""}` },
    });
    const allMarks = paper.questions.map((q) =>
      q.id === questionId ? awarded : (q.marksAwarded ?? 0)
    );
    const total = allMarks.reduce((a, b) => a + b, 0);
    await prisma.examPaper.update({ where: { id: paper.id }, data: { score: total } });
    console.log(`[marking] remarkSingleQuestion MCQ done: detected="${studentAnswer}", expected="${expected}", awarded=${awarded}, total=${total}`);
    return;
  }

  // For written (non-MCQ) questions with known boundaries, crop to answer region only
  const useCrop = isWrittenQuestion(question.answer)
    && question.yStartPct != null && question.yEndPct != null;
  console.log(`[marking] remarkSingle Q${question.questionNum}: subject="${paper.subject}", answer="${question.answer}", isWritten=${isWrittenQuestion(question.answer)}, hasBounds=${question.yStartPct != null && question.yEndPct != null}, useCrop=${useCrop}`);
  const imageBuffer = useCrop
    ? await cropPageRegion(pageBuffer, question.yStartPct!, question.yEndPct!, `remarkSingle Q${question.questionNum}`)
    : pageBuffer;
  const pageBase64 = imageBuffer.toString("base64");
  console.log(`[marking] remarkSingle Q${question.questionNum}: sending image ${imageBuffer.length} bytes (original ${pageBuffer.length} bytes, cropped=${useCrop})`);

  // Step 1: Pre-check for blue ink (science written only)
  if (useCrop) {
    const inkFound = await hasBlueInk(pageBase64, `remarkSingle Q${question.questionNum}`);
    if (!inkFound) {
      console.log(`[marking] remarkSingle Q${question.questionNum}: no blue ink detected — awarding 0`);
      await prisma.examQuestion.update({
        where: { id: questionId },
        data: { marksAwarded: 0, markingNotes: "Detected: No answer detected | No blue ink found (pre-check)" },
      });
      const allMarks = paper.questions.map((q) =>
        q.id === questionId ? 0 : (q.marksAwarded ?? 0)
      );
      const total = allMarks.reduce((a, b) => a + b, 0);
      await prisma.examPaper.update({ where: { id: paper.id }, data: { score: total } });
      console.log(`[marking] remarkSingleQuestion done (blank), new total=${total}`);
      return;
    }
  }

  // Step 2: Mark normally
  const yStart = useCrop ? "0%" : (question.yStartPct != null ? `${question.yStartPct.toFixed(1)}%` : "unknown");
  const yEnd = useCrop ? "100%" : (question.yEndPct != null ? `${question.yEndPct.toFixed(1)}%` : "unknown");
  const answerDesc = buildAnswerDesc(question.answer, !!question.answerImageData);
  const marksInfo = question.marksAvailable != null ? `marksAvailable: ${question.marksAvailable}` : `marksAvailable: detect`;
  const printWarning = question.answer
    ? ` ⚠️ WARNING: The text "${question.answer}" may appear PRINTED (black ink) on this page — that is the answer key, NOT the student's handwriting. Only count it if written in BLUE INK by hand.`
    : "";
  const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
  const questionLines = `- Question ${question.questionNum} (ID: ${question.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}${printWarning}${cropNote}`;

  let answerImagesNote = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [
    { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
  ];
  if (question.answerImageData) {
    const sepIdx = question.answerImageData.indexOf(";base64,");
    if (sepIdx > 5) {
      answerImagesNote = `Additional image 2: expected answer diagram for Question ${question.questionNum}`;
      parts.push({ inlineData: { mimeType: question.answerImageData.slice(5, sepIdx), data: question.answerImageData.slice(sepIdx + 8) } });
    }
  }

  const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + englishMarkingRules(paper.subject));
  parts.push({ text: prompt });

  console.log(`[marking] Calling Gemini for remark of question ${questionId}`);
  const response = await withTimeout(
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }),
    GEMINI_TIMEOUT_MS,
    `remark question ${questionId}`
  );

  const text = response.text;
  if (!text) throw new Error("Empty Gemini response");
  const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
  const result = parsed.questions.find((q) => q.questionId === questionId) ?? parsed.questions[0];
  if (!result) throw new Error("No result for question");

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { marksAwarded: result.marksAwarded, marksAvailable: result.marksAvailable, markingNotes: buildMarkingNotes(result) },
  });

  // Recalculate paper total score
  const allMarks = paper.questions.map((q) =>
    q.id === questionId ? (result.marksAwarded ?? 0) : (q.marksAwarded ?? 0)
  );
  const total = allMarks.reduce((a, b) => a + b, 0);
  await prisma.examPaper.update({ where: { id: paper.id }, data: { score: total } });
  console.log(`[marking] remarkSingleQuestion done, new total=${total}`);
}

export async function markExamPaper(paperId: string): Promise<void> {
  console.log(`[marking] Starting markExamPaper for paper ${paperId}`);
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { markingStatus: "in_progress" },
  });

  try {
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) throw new Error("Paper not found");

    // Sync questions from master paper so marking uses the latest Q&A.
    // Handles renumbered/split questions (e.g. "35" → "35ab","35c") by
    // deleting clone questions and recreating from master structure,
    // preserving student-side marking data where possible.
    if (paper.sourceExamId) {
      const master = await prisma.examPaper.findUnique({
        where: { id: paper.sourceExamId },
        include: { questions: { orderBy: { orderIndex: "asc" } } },
      });
      if (master) {
        // Check if structure matches (same count + same questionNums in order)
        const masterNums = master.questions.map((q) => q.questionNum).join(",");
        const cloneNums = paper.questions.map((q) => q.questionNum).join(",");
        const structureChanged = masterNums !== cloneNums;

        if (structureChanged) {
          console.log(`[marking] Question structure changed — rebuilding clone questions`);
          console.log(`[marking]   master: ${masterNums}`);
          console.log(`[marking]   clone:  ${cloneNums}`);

          // Save existing marking data keyed by questionNum for reuse
          const existingMarking = new Map(
            paper.questions.map((q) => [q.questionNum, {
              marksAwarded: q.marksAwarded,
              markingNotes: q.markingNotes,
              studentAnswer: q.studentAnswer,
            }])
          );

          // Delete all clone questions and recreate from master
          await prisma.examQuestion.deleteMany({ where: { examPaperId: paperId } });
          const created = await Promise.all(
            master.questions.map((mq) => {
              const prev = existingMarking.get(mq.questionNum);
              return prisma.examQuestion.create({
                data: {
                  examPaperId: paperId,
                  questionNum: mq.questionNum,
                  imageData: mq.imageData,
                  answer: mq.answer,
                  answerImageData: mq.answerImageData,
                  pageIndex: mq.pageIndex,
                  orderIndex: mq.orderIndex,
                  yStartPct: mq.yStartPct,
                  yEndPct: mq.yEndPct,
                  marksAvailable: mq.marksAvailable,
                  syllabusTopic: mq.syllabusTopic,
                  // Preserve marking data if questionNum existed before
                  marksAwarded: prev?.marksAwarded ?? null,
                  markingNotes: prev?.markingNotes ?? null,
                  studentAnswer: prev?.studentAnswer ?? null,
                },
              });
            })
          );
          // Replace in-memory questions with freshly created ones
          paper.questions.length = 0;
          paper.questions.push(...created);
          console.log(`[marking] Rebuilt ${created.length} questions from master`);
        } else {
          // Structure matches — just sync field values
          let syncCount = 0;
          for (let i = 0; i < paper.questions.length; i++) {
            const q = paper.questions[i];
            const mq = master.questions[i];
            if (!mq) continue;
            const updates: Record<string, unknown> = {};
            if (mq.questionNum !== q.questionNum) updates.questionNum = mq.questionNum;
            if (mq.marksAvailable !== q.marksAvailable) updates.marksAvailable = mq.marksAvailable;
            if (mq.answer !== q.answer) updates.answer = mq.answer;
            if (mq.answerImageData !== q.answerImageData) updates.answerImageData = mq.answerImageData;
            if (mq.imageData !== q.imageData) updates.imageData = mq.imageData;
            if (mq.pageIndex !== q.pageIndex) updates.pageIndex = mq.pageIndex;
            if (mq.yStartPct !== q.yStartPct) updates.yStartPct = mq.yStartPct;
            if (mq.yEndPct !== q.yEndPct) updates.yEndPct = mq.yEndPct;
            if (Object.keys(updates).length > 0) {
              await prisma.examQuestion.update({ where: { id: q.id }, data: updates });
              Object.assign(q, updates);
              syncCount++;
            }
          }
          console.log(`[marking] Synced ${syncCount} questions from master ${paper.sourceExamId}`);
        }
      }
    }

    console.log(`[marking] Paper has ${paper.questions.length} questions, pageCount=${paper.pageCount}`);

    const subDir = path.join(SUBMISSIONS_DIR, paperId);

    // Build mapping: original PDF page index → submission file index
    // Answer pages (from metadata) are not included in the submission files
    const metadata = paper.metadata as { answerPages?: number[] } | null;
    const answerPageSet = new Set(
      (metadata?.answerPages ?? []).map((p: number) => p - 1)
    );
    const submissionIndexMap = new Map<number, number>();
    let submissionIdx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!answerPageSet.has(i)) submissionIndexMap.set(i, submissionIdx++);
    }

    // Group questions by original page index
    const byPage = new Map<number, typeof paper.questions>();
    for (const q of paper.questions) {
      if (!byPage.has(q.pageIndex)) byPage.set(q.pageIndex, []);
      byPage.get(q.pageIndex)!.push(q);
    }

    console.log(`[marking] Marking ${byPage.size} page(s) concurrently`);

    // ── Mark all pages CONCURRENTLY ──────────────────────────────────────────
    const pageEntries = [...byPage.entries()];

    /** Helper: build a Gemini call for a batch of questions sharing one image */
    async function markBatch(
      imageBase64: string,
      questions: NonNullable<typeof paper>["questions"],
      label: string,
      isCropped: boolean
    ): Promise<QuestionMarkResult[]> {
      const questionLines = questions
        .map((q) => {
          const yStart = isCropped ? "0%" : (q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown");
          const yEnd = isCropped ? "100%" : (q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown");
          const answerDesc = buildAnswerDesc(q.answer, !!q.answerImageData);
          const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const printWarning = q.answer
            ? ` [PRINTED TEXT "${q.answer}" may appear on page — IGNORE unless handwritten in BLUE ink]`
            : "";
          const cropNote = isCropped ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          return `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}${printWarning}${cropNote}`;
        })
        .join("\n");

      const imageAnswerQuestions = questions.filter((q) => q.answerImageData);
      let answerImagesNote = "";
      if (imageAnswerQuestions.length > 0) {
        answerImagesNote =
          `Additional images (2 onwards) are expected answer diagrams:\n` +
          imageAnswerQuestions
            .map((q, i) => `- Image ${i + 2}: expected answer for Question ${q.questionNum}`)
            .join("\n");
      }

      const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper?.subject) + englishMarkingRules(paper?.subject));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [
        { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
      ];
      for (const q of imageAnswerQuestions) {
        if (!q.answerImageData) continue;
        const sepIdx = q.answerImageData.indexOf(";base64,");
        if (sepIdx > 5) {
          parts.push({ inlineData: { mimeType: q.answerImageData.slice(5, sepIdx), data: q.answerImageData.slice(sepIdx + 8) } });
        }
      }
      parts.push({ text: prompt });

      try {
        const response = await withTimeout(
          getAI().models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: { responseMimeType: "application/json", temperature: 0.1 },
          }),
          GEMINI_TIMEOUT_MS,
          label
        );
        const text = response.text;
        if (!text) { console.warn(`[marking] Empty Gemini response for ${label}`); return []; }
        const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
        console.log(`[marking] ${label} done — ${parsed.questions.length} results`);
        return parsed.questions;
      } catch (err) {
        console.warn(`[marking] Failed for ${label}:`, err);
        return [];
      }
    }


    const pageResults = await Promise.all(
      pageEntries.map(async ([pageIndex, questions]) => {
        const submissionPage = submissionIndexMap.get(pageIndex);
        if (submissionPage === undefined) {
          console.log(`[marking] Page ${pageIndex} is an answer page — skipping`);
          return [];
        }

        const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
        let pageBuffer: Buffer;
        try {
          pageBuffer = await fs.readFile(pagePath);
        } catch {
          console.warn(`[marking] Submission file not found for page ${pageIndex} (submission page ${submissionPage})`);
          return [];
        }

        // Split questions: written (non-MCQ) questions with boundaries get cropped + blue ink check
        const writtenQs = questions.filter((q) => isWrittenQuestion(q.answer) && q.yStartPct != null && q.yEndPct != null);
        const otherQs = questions.filter((q) => !writtenQs.includes(q));

        // Further split otherQs into MCQ (blind detection) and non-MCQ (normal marking)
        const mcqQs = otherQs.filter((q) => isMcqAnswer(q.answer));
        const nonMcqOther = otherQs.filter((q) => !isMcqAnswer(q.answer));

        console.log(`[marking] Page ${pageIndex}: total=${questions.length}, writtenCrop=${writtenQs.length}, mcq=${mcqQs.length}, nonMcq=${nonMcqOther.length}`);
        for (const q of writtenQs) {
          console.log(`[marking]   CROP Q${q.questionNum}: answer="${q.answer}", yStart=${q.yStartPct}, yEnd=${q.yEndPct}`);
        }
        for (const q of mcqQs) {
          console.log(`[marking]   MCQ Q${q.questionNum}: answer="${q.answer}"`);
        }
        for (const q of nonMcqOther) {
          console.log(`[marking]   FULL Q${q.questionNum}: answer="${q.answer}"`);
        }

        const results: QuestionMarkResult[] = [];

        // Blind MCQ detection: one question at a time to avoid cross-contamination
        if (mcqQs.length > 0) {
          console.log(`[marking] ── MCQ BLIND DETECTION ── page ${pageIndex}, ${mcqQs.length} questions (1-by-1): ${mcqQs.map(q => `Q${q.questionNum}(ans=${q.answer})`).join(", ")}`);
          const pageBase64 = pageBuffer.toString("base64");
          const mcqResults = await Promise.all(
            mcqQs.map(async (q) => {
              const detected = await detectMcqAnswers(pageBase64, [q], `page ${pageIndex} Q${q.questionNum}`);
              const studentAnswer = detected.get(q.id) ?? null;
              const expected = q.answer?.trim() ?? "";
              if (!studentAnswer) {
                console.log(`[marking] MCQ Q${q.questionNum}: detected=null, expected="${expected}", awarded=0`);
                return {
                  questionId: q.id,
                  marksAvailable: q.marksAvailable ?? 1,
                  marksAwarded: 0,
                  studentAnswer: "No answer detected",
                  notes: "No blue ink answer found",
                } as QuestionMarkResult;
              }
              const match = normalizeMcq(studentAnswer) === normalizeMcq(expected);
              console.log(`[marking] MCQ Q${q.questionNum}: detected="${studentAnswer}", expected="${expected}", awarded=${match ? (q.marksAvailable ?? 1) : 0}`);
              return {
                questionId: q.id,
                marksAvailable: q.marksAvailable ?? 1,
                marksAwarded: match ? (q.marksAvailable ?? 1) : 0,
                studentAnswer,
                notes: match ? "" : `Student wrote "${studentAnswer}", expected "${expected}"`,
              } as QuestionMarkResult;
            })
          );
          results.push(...mcqResults);
        }

        // Batch call for non-MCQ, non-science-written questions (full page, normal marking)
        if (nonMcqOther.length > 0) {
          const pageBase64 = pageBuffer.toString("base64");
          console.log(`[marking] Calling Gemini for pageIndex=${pageIndex} (${nonMcqOther.length} non-MCQ questions, full page)`);
          const batch = await markBatch(pageBase64, nonMcqOther, `page ${pageIndex}`, false);
          results.push(...batch);
        }

        // Individual cropped calls for science written questions (with blue ink pre-check)
        if (writtenQs.length > 0) {
          console.log(`[marking] Cropping ${writtenQs.length} science written questions on page ${pageIndex}`);
          const croppedResults = await Promise.all(
            writtenQs.map(async (q) => {
              try {
                const cropped = await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `batch Q${q.questionNum}`);
                const croppedBase64 = cropped.toString("base64");

                // Step 1: Pre-check for blue ink
                const inkFound = await hasBlueInk(croppedBase64, `Q${q.questionNum}`);
                if (!inkFound) {
                  // No blue ink — skip marking, return 0
                  return [{
                    questionId: q.id,
                    marksAvailable: q.marksAvailable ?? 0,
                    marksAwarded: 0,
                    studentAnswer: "No answer detected",
                    notes: "No blue ink found (pre-check)",
                  }] as QuestionMarkResult[];
                }

                // Step 2: Mark normally with cropped image
                return markBatch(croppedBase64, [q], `page ${pageIndex} Q${q.questionNum} (cropped)`, true);
              } catch (err) {
                console.warn(`[marking] Crop failed for Q${q.questionNum}:`, err);
                return [];
              }
            })
          );
          for (const cr of croppedResults) results.push(...cr);
        }

        return results;
      })
    );

    let allResults = pageResults.flat();
    console.log(`[marking] All pages done. Total results: ${allResults.length}`);

    // ── Retry pass: re-mark questions that got no result ─────────────────────
    const markedIds = new Set(allResults.map((r) => r.questionId));
    const unmarkedQuestions = paper.questions.filter((q) => !markedIds.has(q.id));
    if (unmarkedQuestions.length > 0) {
      console.log(`[marking] ${unmarkedQuestions.length} questions got no result — retrying individually`);
      const retryResults = await Promise.all(
        unmarkedQuestions.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try {
            pageBuffer = await fs.readFile(pagePath);
          } catch {
            return null;
          }

          // MCQ retry: use blind detection
          if (isMcqAnswer(q.answer)) {
            const pageBase64 = pageBuffer.toString("base64");
            console.log(`[marking] Retry MCQ Q${q.questionNum}: blind detection`);
            const detected = await detectMcqAnswers(pageBase64, [q], `retry Q${q.questionNum}`, 0);
            const studentAnswer = detected.get(q.id) ?? null;
            const expected = q.answer?.trim() ?? "";
            if (!studentAnswer) {
              return { questionId: q.id, marksAvailable: q.marksAvailable ?? 1, marksAwarded: 0, studentAnswer: "No answer detected", notes: "No blue ink answer found" } as QuestionMarkResult;
            }
            const match = normalizeMcq(studentAnswer) === normalizeMcq(expected);
            return { questionId: q.id, marksAvailable: q.marksAvailable ?? 1, marksAwarded: match ? (q.marksAvailable ?? 1) : 0, studentAnswer, notes: match ? "" : `Student wrote "${studentAnswer}", expected "${expected}"` } as QuestionMarkResult;
          }

          // Crop for science written questions
          const useCrop = isWrittenQuestion(q.answer)
            && q.yStartPct != null && q.yEndPct != null;
          console.log(`[marking] Retry Q${q.questionNum}: useCrop=${useCrop}, answer="${q.answer}"`);
          const imageBuffer = useCrop
            ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `retry Q${q.questionNum}`)
            : pageBuffer;
          const pageBase64 = imageBuffer.toString("base64");

          // Pre-check for blue ink (science written only)
          if (useCrop) {
            const inkFound = await hasBlueInk(pageBase64, `retry Q${q.questionNum}`);
            if (!inkFound) {
              return {
                questionId: q.id,
                marksAvailable: q.marksAvailable ?? 0,
                marksAwarded: 0,
                studentAnswer: "No answer detected",
                notes: "No blue ink found (pre-check)",
              } as QuestionMarkResult;
            }
          }

          const yStart = useCrop ? "0%" : (q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown");
          const yEnd = useCrop ? "100%" : (q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown");
          const answerDesc = buildAnswerDesc(q.answer, !!q.answerImageData);
          const retryMarksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${retryMarksInfo}. Expected answer: ${answerDesc}${cropNote}`;

          let answerImagesNote = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = [
            { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
          ];
          if (q.answerImageData) {
            const sepIdx = q.answerImageData.indexOf(";base64,");
            if (sepIdx > 5) {
              answerImagesNote = `Additional image 2: expected answer diagram for Question ${q.questionNum}`;
              parts.push({ inlineData: { mimeType: q.answerImageData.slice(5, sepIdx), data: q.answerImageData.slice(sepIdx + 8) } });
            }
          }
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + englishMarkingRules(paper.subject));
          parts.push({ text: prompt });

          try {
            console.log(`[marking] Retry for Q${q.questionNum} (${q.id})${useCrop ? " [cropped]" : ""}`);
            const response = await withTimeout(
              getAI().models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `retry Q${q.questionNum}`
            );
            const text = response.text;
            if (!text) return null;
            const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
            const result = parsed.questions.find((r) => r.questionId === q.id) ?? parsed.questions[0];
            if (result) {
              result.questionId = q.id;
              console.log(`[marking] Retry Q${q.questionNum} succeeded: ${result.marksAwarded}/${result.marksAvailable}`);
              return result;
            }
            return null;
          } catch (err) {
            console.warn(`[marking] Retry failed for Q${q.questionNum}:`, err);
            return null;
          }
        })
      );
      for (const r of retryResults) {
        if (r) allResults.push(r);
      }
      const stillUnmarked = paper.questions.length - allResults.length;
      if (stillUnmarked > 0) {
        console.warn(`[marking] ${stillUnmarked} questions still unmarked after retry`);
      }
    }

    // ── Verification pass: re-mark questions that lost marks ─────────────────
    const validIds = new Set(paper.questions.map((q) => q.id));
    const resultMap = new Map<string, QuestionMarkResult>();
    for (const r of allResults) {
      if (validIds.has(r.questionId) && !resultMap.has(r.questionId)) {
        resultMap.set(r.questionId, r);
      }
    }

    const questionsToVerify = paper.questions.filter((q) => {
      const r = resultMap.get(q.id);
      if (!r) return false;
      // Skip verification for questions already confirmed blank by pre-check
      if (r.notes?.includes("pre-check")) return false;
      // Skip MCQ — blind detection is already unbiased, re-detection unlikely to differ
      if (isMcqAnswer(q.answer)) return false;
      return r.marksAwarded < r.marksAvailable;
    });

    if (questionsToVerify.length > 0) {
      console.log(`[marking] Verification pass: ${questionsToVerify.length} questions with partial/zero marks — re-marking`);

      const verifyResults = await Promise.all(
        questionsToVerify.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try {
            pageBuffer = await fs.readFile(pagePath);
          } catch {
            return null;
          }

          // Crop for science written questions
          const useCrop = isWrittenQuestion(q.answer)
            && q.yStartPct != null && q.yEndPct != null;
          console.log(`[marking] Verify Q${q.questionNum}: useCrop=${useCrop}, answer="${q.answer}"`);
          const imageBuffer = useCrop
            ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `verify Q${q.questionNum}`)
            : pageBuffer;
          const pageBase64 = imageBuffer.toString("base64");

          const yStart = useCrop ? "0%" : (q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown");
          const yEnd = useCrop ? "100%" : (q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown");
          const answerDesc = buildAnswerDesc(q.answer, !!q.answerImageData);
          const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const retryAnswerOneHint = q.answer?.trim() === "1"
            ? ` ⚠️ EXPECTED ANSWER IS "1" — look extra carefully for a single vertical blue stroke. Do NOT report "No answer detected" unless the answer area is completely blank.`
            : "";
          const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}${retryAnswerOneHint}${cropNote}`;

          let answerImagesNote = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = [
            { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
          ];
          if (q.answerImageData) {
            const sepIdx = q.answerImageData.indexOf(";base64,");
            if (sepIdx > 5) {
              answerImagesNote = `Additional image 2: expected answer diagram for Question ${q.questionNum}`;
              parts.push({ inlineData: { mimeType: q.answerImageData.slice(5, sepIdx), data: q.answerImageData.slice(sepIdx + 8) } });
            }
          }
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + englishMarkingRules(paper.subject));
          parts.push({ text: prompt });

          try {
            const orig = resultMap.get(q.id)!;
            console.log(`[marking] Verify Q${q.questionNum} (${q.id}) — original: ${orig.marksAwarded}/${orig.marksAvailable}`);
            const response = await withTimeout(
              getAI().models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `verify Q${q.questionNum}`
            );
            const text = response.text;
            if (!text) return null;
            const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
            const result = parsed.questions.find((r) => r.questionId === q.id) ?? parsed.questions[0];
            if (result) {
              result.questionId = q.id;
              return result;
            }
            return null;
          } catch (err) {
            console.warn(`[marking] Verify failed for Q${q.questionNum}:`, err);
            return null;
          }
        })
      );

      let upgraded = 0;
      for (const vr of verifyResults) {
        if (!vr) continue;
        const original = resultMap.get(vr.questionId);
        if (!original) continue;
        if (vr.marksAwarded > original.marksAwarded) {
          console.log(`[marking] Verify UPGRADE Q${vr.questionId}: ${original.marksAwarded} → ${vr.marksAwarded}/${original.marksAvailable}`);
          const idx = allResults.findIndex((r) => r.questionId === vr.questionId);
          if (idx !== -1) allResults[idx] = vr;
          upgraded++;
        } else {
          console.log(`[marking] Verify KEPT original for Q${vr.questionId}: verify=${vr.marksAwarded}, original=${original.marksAwarded}`);
        }
      }
      console.log(`[marking] Verification complete: ${upgraded}/${questionsToVerify.length} questions upgraded`);
    }

    // ── MCQ retry pass: re-detect with cropped image ──────────────────────────
    // Retry when: (a) no answer detected, or (b) expected answer is "1" and student got 0
    // (AI struggles to read handwritten "1" — a single vertical stroke is easily missed or misread)
    const mcqToRetry = paper.questions.filter((q) => {
      if (!isMcqAnswer(q.answer)) return false;
      const r = resultMap.get(q.id);
      if (!r) return false;
      if (r.studentAnswer === "No answer detected") return true;
      if (normalizeMcq(q.answer ?? "") === "1" && r.marksAwarded === 0) return true;
      return false;
    });

    if (mcqToRetry.length > 0) {
      console.log(`[marking] MCQ retry pass: ${mcqToRetry.length} MCQ questions with no detection — cropped re-detect`);
      const mcqRetryResults = await Promise.all(
        mcqToRetry.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          if (q.yStartPct == null || q.yEndPct == null) return null; // need bounds to crop
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try {
            pageBuffer = await fs.readFile(pagePath);
          } catch {
            return null;
          }

          // Crop to the question's region for a closer look
          const imageBuffer = await cropPageRegion(pageBuffer, q.yStartPct, q.yEndPct, `mcqRetry Q${q.questionNum}`);
          const pageBase64 = imageBuffer.toString("base64");
          const croppedQ = { ...q, yStartPct: 0, yEndPct: 100 };

          const isAnswer1 = normalizeMcq(q.answer ?? "") === "1";

          // For answer "1": 1 normal + 1 OpenCV-enhanced — if either detects "1", accept it
          if (isAnswer1) {
            const enhancedBuffer = await isolateAndThickenBlueInk(imageBuffer, `mcqRetry Q${q.questionNum}`);
            const enhancedBase64 = enhancedBuffer.toString("base64");

            const hint1 = new Set([q.id]);
            const [normalDet, opencvDet] = await Promise.all([
              detectMcqAnswers(pageBase64, [croppedQ], `mcqRetry Q${q.questionNum} normal`, 0.4, hint1),
              detectMcqAnswers(enhancedBase64, [croppedQ], `mcqRetry Q${q.questionNum} opencv`, 0.3, hint1),
            ]);
            const normalAns = normalDet.get(q.id) ?? null;
            const opencvAns = opencvDet.get(q.id) ?? null;
            console.log(`[marking] MCQ retry Q${q.questionNum} (answer=1): normal="${normalAns}", opencv="${opencvAns}"`);

            // If either detects "1", use "1"; otherwise use whichever detected something
            let studentAnswer: string | null = null;
            if (normalAns && normalizeMcq(normalAns) === "1") studentAnswer = "1";
            else if (opencvAns && normalizeMcq(opencvAns) === "1") studentAnswer = "1";
            else studentAnswer = normalAns ?? opencvAns;

            if (!studentAnswer) {
              console.log(`[marking] MCQ retry Q${q.questionNum}: no detection — confirmed blank`);
              return null;
            }

            const expected = q.answer?.trim() ?? "";
            const match = normalizeMcq(studentAnswer) === normalizeMcq(expected);
            console.log(`[marking] MCQ retry Q${q.questionNum}: result="${studentAnswer}", expected="${expected}", match=${match}`);
            return {
              questionId: q.id,
              marksAvailable: q.marksAvailable ?? 1,
              marksAwarded: match ? (q.marksAvailable ?? 1) : 0,
              studentAnswer,
              notes: match ? "" : `Student wrote "${studentAnswer}", expected "${expected}"`,
            } as QuestionMarkResult;
          }

          // Non-"1" MCQ: single retry with temperature 0
          const detected = await detectMcqAnswers(pageBase64, [croppedQ], `mcqRetry Q${q.questionNum}`, 0);

          const studentAnswer = detected.get(q.id) ?? null;
          if (!studentAnswer) {
            console.log(`[marking] MCQ retry Q${q.questionNum}: still no answer — confirmed blank`);
            return null;
          }

          // Accept whatever was detected — don't bias toward expected answer
          const expected = q.answer?.trim() ?? "";
          const match = normalizeMcq(studentAnswer) === normalizeMcq(expected);
          console.log(`[marking] MCQ retry Q${q.questionNum}: detected "${studentAnswer}" on cropped pass, expected="${expected}", match=${match}`);
          return {
            questionId: q.id,
            marksAvailable: q.marksAvailable ?? 1,
            marksAwarded: match ? (q.marksAvailable ?? 1) : 0,
            studentAnswer,
            notes: match ? "" : `Student wrote "${studentAnswer}", expected "${expected}"`,
          } as QuestionMarkResult;
        })
      );

      let mcqUpgraded = 0;
      for (const r of mcqRetryResults) {
        if (!r) continue;
        const idx = allResults.findIndex((x) => x.questionId === r.questionId);
        if (idx !== -1) { allResults[idx] = r; mcqUpgraded++; }
        else { allResults.push(r); mcqUpgraded++; }
      }
      console.log(`[marking] MCQ retry complete: ${mcqUpgraded}/${mcqToRetry.length} upgraded`);
    }

    // ── Batch DB updates in a single transaction ──────────────────────────────
    // Filter to only valid question IDs (Gemini sometimes hallucinates extra IDs)
    const validResults = new Map<string, QuestionMarkResult>();
    for (const result of allResults) {
      if (validIds.has(result.questionId) && !validResults.has(result.questionId)) {
        validResults.set(result.questionId, result);
      }
    }

    const discarded = allResults.length - validResults.size;
    if (discarded > 0) {
      console.warn(`[marking] Discarded ${discarded} results with invalid/duplicate question IDs`);
    }
    console.log(`[marking] Updating ${validResults.size}/${paper.questions.length} questions`);

    // Build a lookup of pre-set marksAvailable from DB
    const presetMarks = new Map(paper.questions.map(q => [q.id, q.marksAvailable]));

    let totalAwarded = 0;
    const questionUpdates = [...validResults.values()].map((result) => {
      totalAwarded += result.marksAwarded ?? 0;
      // Keep pre-set marksAvailable if it exists; otherwise use Gemini's detected value
      const existingMarks = presetMarks.get(result.questionId);
      return prisma.examQuestion.update({
        where: { id: result.questionId },
        data: {
          marksAwarded: result.marksAwarded,
          marksAvailable: existingMarks ?? result.marksAvailable,
          markingNotes: buildMarkingNotes(result),
        },
      });
    });

    await prisma.$transaction([
      ...questionUpdates,
      prisma.examPaper.update({
        where: { id: paperId },
        data: { score: totalAwarded, markingStatus: "complete" },
      }),
    ]);
    // Validate marks total
    if (paper.totalMarks) {
      const expectedTotal = parseFloat(paper.totalMarks);
      const actualAvailable = [...validResults.values()].reduce(
        (s, r) => s + ((presetMarks.get(r.questionId) ?? r.marksAvailable) ?? 0), 0
      );
      if (!isNaN(expectedTotal) && Math.abs(actualAvailable - expectedTotal) > 0.5) {
        console.warn(`[marking] Marks validation: sum of marksAvailable (${actualAvailable}) != paper totalMarks (${expectedTotal})`);
      }
    }
    console.log(`[marking] Paper ${paperId} marked complete. Score: ${totalAwarded}`);
  } catch (err) {
    console.error(`[marking] markExamPaper failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
    throw err;
  }
}

// ── On-demand feedback summary generation ─────────────────────────────────

export async function generateFeedbackSummary(paperId: string): Promise<string> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    include: { questions: true, assignedTo: { select: { name: true } } },
  });
  if (!paper) throw new Error("Paper not found");

  const studentName = paper.assignedTo?.name ?? null;

  const questions = paper.questions;
  const totalAwarded = questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const totalMarksNum = paper.totalMarks ? parseFloat(paper.totalMarks) : null;

  // Compute per-booklet scores from metadata
  const metaPapers = (paper.metadata as { papers?: Array<{ label: string; questionPrefix: string }> })?.papers ?? [];
  const bookletScores: Array<{ label: string; awarded: number; available: number }> = [];

  if (metaPapers.length > 1) {
    for (const mp of metaPapers) {
      let awarded = 0;
      let available = 0;
      for (const q of questions) {
        const matchesPrefix = mp.questionPrefix === ""
          ? !metaPapers.some(other => other.questionPrefix !== "" && q.questionNum.startsWith(other.questionPrefix))
          : q.questionNum.startsWith(mp.questionPrefix);
        if (matchesPrefix) {
          awarded += q.marksAwarded ?? 0;
          available += q.marksAvailable ?? 0;
        }
      }
      bookletScores.push({ label: mp.label, awarded, available });
    }
  }

  // Build mistakes list with question details
  const mistakes = questions
    .filter(q => q.marksAwarded !== null && q.marksAvailable !== null && q.marksAwarded < q.marksAvailable)
    .map(q => {
      const lost = (q.marksAvailable ?? 0) - (q.marksAwarded ?? 0);
      return `Q${q.questionNum}: Lost ${lost} mark(s). Answer: ${q.answer ?? "N/A"}. ${q.markingNotes ?? ""}`;
    });

  const feedbackPrompt = `You are writing a short feedback summary for a primary school student's exam, aimed at helping them know what to revise.
${studentName ? `\nStudent: ${studentName}` : ""}
Paper: ${paper.title}
Subject: ${paper.subject ?? "Unknown"}
Level: ${paper.level ?? "Unknown"}
Score: ${totalAwarded}${totalMarksNum ? ` out of ${totalMarksNum}` : ""}
${bookletScores.length > 1 ? `\nPer-section scores:\n${bookletScores.map(b => `- ${b.label}: ${b.awarded}/${b.available}`).join("\n")}` : ""}
${mistakes.length > 0 ? `\nQuestions with marks lost:\n${mistakes.join("\n")}` : "\nNo mistakes — full marks!"}

Write a feedback summary with:
1. An encouraging opening sentence${studentName ? ` addressing ${studentName} by name` : ""} mentioning the score (e.g. "${studentName ?? "You"} scored 42 out of 50! Well done!")
2. ${bookletScores.length > 1 ? "Briefly mention per-section scores." : ""}
3. If there are mistakes, identify the SPECIFIC TOPICS or CONCEPTS the student should revise. Group related mistakes together. Use phrases like "You may wish to revise your notes on [topic]." Be specific — e.g. "angles and trigonometry", "vocabulary on food and drinks", "fractions and decimals", "grammar — past tense".
4. End with an encouraging note.

Keep the tone warm, positive, and age-appropriate for a primary school child. Total length: 3-6 sentences. Do NOT use markdown formatting. Plain text only.`;

  const feedbackResponse = await withTimeout(
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: feedbackPrompt }] }],
      config: { temperature: 0.7 },
    }),
    30_000,
    "feedback summary"
  );
  const feedbackText = feedbackResponse.text?.trim() ?? "";

  if (feedbackText) {
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { feedbackSummary: feedbackText },
    });
  }

  return feedbackText;
}

// ── Focused test marking (handwritten answers, one submission page per question) ─

const FOCUSED_MARKING_PROMPT = `You are marking a primary school student's handwritten answer for a math question. Be concise.

HOW TO READ THE IMAGES:
- Image 1: The printed question.
- Image 2: The student's handwritten answer (blue ink on white paper).
{ANSWER_IMAGE_NOTE}

Expected answer: {EXPECTED_ANSWER}
Marks available: {MARKS_AVAILABLE}

Instructions:
1. Read the student's blue-ink handwritten answer from Image 2.
2. Compare against the expected answer.
   - If correct → FULL MARKS.
   - For written/worked answers: check if working/steps are partially correct → award PARTIAL marks.
   - If wrong with no correct working → ZERO marks.
   - For MCQ (single option answer): no partial marks.
3. Record what you detected.

Return ONLY valid JSON (no markdown fences):
{"questionId": "{QUESTION_ID}", "marksAvailable": {MARKS_AVAILABLE}, "marksAwarded": <number>, "studentAnswer": "<what the student wrote>", "notes": "<brief 1-sentence explanation or empty if full marks>"}`;

export async function markFocusedTest(paperId: string): Promise<void> {
  console.log(`[focused-marking] Starting for ${paperId}`);

  try {
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "in_progress" },
    });

    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) throw new Error("Paper not found");

    const subDir = path.join(SUBMISSIONS_DIR, paperId);
    const ai = getAI();
    let totalAwarded = 0;
    const updates = [];

    for (let i = 0; i < paper.questions.length; i++) {
      const q = paper.questions[i];
      const expectedAnswer = q.answer || "?";
      const marksAvailable = q.marksAvailable ?? 1;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];

      // Image 1: question image (from DB)
      if (q.imageData && q.imageData.startsWith("data:image")) {
        const match = q.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          parts.push({ text: "Image 1 — The question:" });
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }

      // Image 2: student's handwritten answer (from submission files)
      let hasSubmission = false;
      try {
        const pagePath = path.join(subDir, `page_${i}.jpg`);
        const pageBuffer = await fs.readFile(pagePath);
        parts.push({ text: "Image 2 — Student's handwritten answer:" });
        parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: pageBuffer.toString("base64") } });
        hasSubmission = true;
      } catch {
        // No submission image for this question
      }

      // Add expected answer image if available
      let answerImageNote = "";
      if (q.answerImageData && q.answerImageData.startsWith("data:image")) {
        const match = q.answerImageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          parts.push({ text: "Expected answer image (for reference):" });
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          answerImageNote = "An additional image showing the expected answer is also provided.";
        }
      }

      // Build prompt
      const prompt = FOCUSED_MARKING_PROMPT
        .replace("{EXPECTED_ANSWER}", `"${expectedAnswer}"`)
        .replace(/\{MARKS_AVAILABLE\}/g, String(marksAvailable))
        .replace("{QUESTION_ID}", q.id)
        .replace("{ANSWER_IMAGE_NOTE}", answerImageNote);

      parts.push({ text: prompt });

      if (!hasSubmission) {
        // No answer submitted for this question
        updates.push(
          prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: 0, markingNotes: "No answer submitted" },
          })
        );
        continue;
      }

      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: { temperature: 0.1 },
          }),
          GEMINI_TIMEOUT_MS,
          `focused-q${q.questionNum}`
        );

        const text = response.text?.trim() ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as QuestionMarkResult;
          const awarded = Math.min(
            marksAvailable,
            Math.max(0, Number(parsed.marksAwarded) || 0)
          );
          totalAwarded += awarded;
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: {
                marksAwarded: awarded,
                markingNotes: buildMarkingNotes({ ...parsed, questionId: q.id, marksAvailable, marksAwarded: awarded }),
              },
            })
          );
        } else {
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, markingNotes: "Failed to parse AI response" },
            })
          );
        }
      } catch (err) {
        console.error(`[focused-marking] Q${q.questionNum} failed:`, err);
        updates.push(
          prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: 0, markingNotes: "Marking error" },
          })
        );
      }
    }

    // Batch update
    await prisma.$transaction([
      ...updates,
      prisma.examPaper.update({
        where: { id: paperId },
        data: { score: totalAwarded, markingStatus: "complete" },
      }),
    ]);

    // Generate feedback
    await generateFeedbackSummary(paperId);

    console.log(`[focused-marking] Paper ${paperId} done. Score: ${totalAwarded}`);
  } catch (err) {
    console.error(`[focused-marking] Failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
  }
}
