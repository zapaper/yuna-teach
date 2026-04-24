import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { Prisma } from "@prisma/client";
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

/** Check if a PNG buffer has any non-transparent pixels (alpha > 0).
 *  Parses raw IDAT chunks without a full image library. */
function hasOpaquePixels(pngBuffer: Buffer): boolean {
  try {
    const zlib = require("zlib");
    // Collect all IDAT chunk data
    const idatChunks: Buffer[] = [];
    let offset = 8; // skip PNG signature
    while (offset < pngBuffer.length - 4) {
      const len = pngBuffer.readUInt32BE(offset);
      const type = pngBuffer.toString("ascii", offset + 4, offset + 8);
      if (type === "IDAT") {
        idatChunks.push(pngBuffer.subarray(offset + 8, offset + 8 + len));
      }
      offset += 12 + len; // length(4) + type(4) + data(len) + crc(4)
    }
    if (idatChunks.length === 0) return false;
    const compressed = Buffer.concat(idatChunks);
    const raw = zlib.inflateSync(compressed);
    // Read IHDR for width and color type
    const width = pngBuffer.readUInt32BE(16);
    const colorType = pngBuffer[25]; // 6 = RGBA, 4 = GA, 2 = RGB, 0 = G
    const bpp = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
    const alphaOffset = colorType === 6 ? 3 : colorType === 4 ? 1 : -1;
    if (alphaOffset < 0) return true; // No alpha channel — can't determine, assume ink
    const rowLen = 1 + width * bpp;
    // Unfilter and check alpha — need previous row for Up/Average/Paeth
    const prevRow = Buffer.alloc(width * bpp);
    for (let y = 0; y * rowLen < raw.length; y++) {
      const filterType = raw[y * rowLen];
      const rowStart = y * rowLen + 1;
      // Unfilter row in-place
      for (let x = 0; x < width * bpp; x++) {
        const rawByte = raw[rowStart + x];
        const a = x >= bpp ? raw[rowStart + x - bpp] : 0; // left pixel (already unfiltered)
        const b = prevRow[x]; // above pixel
        let unfiltered: number;
        switch (filterType) {
          case 0: unfiltered = rawByte; break; // None
          case 1: unfiltered = (rawByte + a) & 0xff; break; // Sub
          case 2: unfiltered = (rawByte + b) & 0xff; break; // Up
          case 3: unfiltered = (rawByte + ((a + b) >>> 1)) & 0xff; break; // Average
          case 4: { // Paeth
            const c = x >= bpp ? prevRow[x - bpp] : 0;
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            unfiltered = (rawByte + pr) & 0xff;
            break;
          }
          default: unfiltered = rawByte;
        }
        raw[rowStart + x] = unfiltered; // store unfiltered for next pixel's "left" reference
      }
      // Check alpha values in this unfiltered row
      for (let x = 0; x < width; x++) {
        const alpha = raw[rowStart + x * bpp + alphaOffset];
        if (alpha > 10) return true;
      }
      // Save this row as previous for next iteration
      raw.copy(prevRow, 0, rowStart, rowStart + width * bpp);
    }
    return false;
  } catch {
    // If PNG parsing fails, assume ink exists to avoid false negatives
    return true;
  }
}

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
  // Padding: 1% above (don't bleed into previous question), 6% below (student's final
  // answer / "Ans:" line often sits right at the bottom boundary — be generous)
  const padTop = height * 0.01;
  const padBottom = height * 0.06;
  const top = Math.max(0, Math.round((yStartPct / 100) * height - padTop));
  const bottom = Math.min(height, Math.round((yEndPct / 100) * height + padBottom));
  const cropHeight = Math.max(1, bottom - top);
  const cropped = await sharp(pageBuffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .jpeg()
    .toBuffer();
  console.log(`[marking] CROP ${label}: original ${width}x${height}, yStart=${yStartPct}% yEnd=${yEndPct}% padTop=${(padTop/height*100).toFixed(1)}% padBottom=${(padBottom/height*100).toFixed(1)}% → top=${top}px bottom=${bottom}px cropH=${cropHeight}px, size=${cropped.length}b`);
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
async function hasBlueInk(imageBase64: string, label: string, mimeType: "image/jpeg" | "image/png" = "image/jpeg"): Promise<boolean> {
  const prompt = `Look at this image carefully. Is there ANY handwritten writing or marks that could be a student's answer?

This includes:
- Blue or blue-black ink (any shade — dark blue, light blue, navy, blue-black)
- Any handwritten strokes, letters, words, or marks that are NOT printed black text
- Even faint, light, or partially visible blue marks count
- Pencil-like or grey-blue marks from a ballpoint pen also count

Do NOT count: printed black text, pre-printed lines, boxes, or diagrams on the exam paper.

IMPORTANT: If you can see ANY marks that could be a student's handwriting — even if faint or unclear — answer YES.
Only answer NO if the answer area is completely blank with absolutely no handwritten marks whatsoever.

Reply with ONLY one word: YES or NO.`;

  try {
    const response = await withTimeout(
      getAI().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: prompt },
        ]}],
        config: { temperature: 0.1 },
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
- "1" = a single short vertical stroke (like | or l or I). No curves. May have a small top serif or tick. VERY EASY TO MISS — it looks like a simple line. If you detect what looks like the letter "I", report it as "1" — they are identical in handwriting.
- "2" = starts high, curves right, then sweeps left with a flat base (like a mirrored Z)
- "3" = two bumps on the right side, open on the left
- "4" = angular top-left stroke, vertical right stroke, horizontal crossbar

WHERE TO LOOK — RIGHT MARGIN ONLY:
- The student writes their MCQ answer in BLUE INK at the RIGHTMOST edge of the page (the far right margin)
- Look ONLY at the rightmost ~10% of the page width within the question's vertical strip
- The answer box / answer bubble / answer circle is printed at the far right — the student writes inside or next to it
- IGNORE all blue ink that appears in the centre or left portion of the page — that is working, calculations, or rough work, NOT the MCQ answer
- A digit written in working steps mid-page is NEVER the MCQ answer, even if it is blue and even if it is 1/2/3/4

How to distinguish BLUE handwriting from BLACK print:
- Printed option labels "(1)", "(2)", "(3)", "(4)" scattered across the question are BLACK — IGNORE them all
- The student's BLUE INK answer is at the FAR RIGHT MARGIN only, written separately from any printed text
- Blue ink has a distinctly BLUE hue — it looks different from black printed text
- If you are unsure whether a mark is blue or black, it is probably black (printed) — report null

STRICT RULES:
1. ONLY report a digit/letter if it is clearly written in BLUE INK by hand at the RIGHTMOST margin
2. Any blue digit found in the middle of the page (working steps, calculations) — IGNORE completely
3. If the only digits you see are BLACK PRINTED text → report null (student left it blank)
4. Do NOT read printed black "(1)", "(2)" etc. as the student's answer
5. Each question's region is independent — do NOT mix up answers between regions
6. Report your confidence: "high" if clearly blue handwriting at right margin, "low" if uncertain
7. For any question with the ⚠️ HINT: look extra carefully for a thin vertical blue stroke at the right margin only — "1" is the most missed digit

Questions:
${qLines}

Return ONLY valid JSON (no markdown fences):
{
  "answers": [
    {"questionId": "ID", "detected": "1", "confidence": "high"},
    {"questionId": "ID", "detected": null, "confidence": "high"}
  ]
}`;

  // Use a stronger model when any question on this page has expected answer "1"
  // (thin vertical stroke — easily missed by 2.5 Flash)
  const mcqModel = hintAnswer1QuestionIds.size > 0 ? "gemini-3-flash-preview" : "gemini-2.5-flash";

  try {
    const response = await withTimeout(
      getAI().models.generateContent({
        model: mcqModel,
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
  const a = answer.trim();
  if (/^\(?[1-4A-Da-d]\)?$/.test(a)) return true;
  // Handle "X or Y" (e.g. "3 or 4", "(1) or (3)")
  // Do NOT split on "/" — it catches fractions like "1/4", "2/3"
  const normalized = a.replace(/[().]/g, "").trim();
  const parts = normalized.split(/\s+or\s+/).map(p => p.trim());
  if (parts.length > 1 && parts.every(p => /^[1-4A-Da-d]$/.test(p))) return true;
  return false;
}

/** Grammar Cloze and Comprehension Cloze answers are words/letters, never MCQ choices.
 *  Even if the answer field is a single letter (e.g. "D"), treat as written. */
function isClozeQuestion(syllabusTopic: string | null | undefined): boolean {
  return syllabusTopic === "Grammar Cloze" || syllabusTopic === "Comprehension Cloze";
}

/** Normalize MCQ answer for comparison: strip parens, uppercase.
 *  Capital "I" is treated as "1" — they are visually identical in handwriting
 *  and "I" is never a valid MCQ option (options are 1–4 or A–D). */
function normalizeMcq(val: string): string {
  const upper = val.trim().replace(/[()]/g, "").toUpperCase();
  return upper === "I" ? "1" : upper;
}

/** Parse a flat answer string like "a) X | b) Y" or "(b) foo (c) bar" into
 *  a map of part-label -> answer text. Returns empty map if no part markers.
 *
 *  Labels accepted: single letter (a, b, c, …) AND roman-nested labels
 *  common in Singapore primary papers — (ai), (aii), (aiii), (bi), (bii),
 *  (ci), (civ), (dv). The label captures a letter followed by an optional
 *  short roman tail (i/ii/iii/iv/v/vi/vii/viii). The older single-letter
 *  regex missed "(ai)"-style labels entirely, so the marker reported
 *  "no answer key provided" for those parts. */
export function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!answer || !answer.trim()) return result;
  const re = /(^|[|\n])\s*\(?([a-z](?:i{1,4}|iv|v|vi{0,3})?)\)\s*/gi;
  const matches = [...answer.matchAll(re)];
  if (matches.length === 0) return result;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const label = m[2].toLowerCase();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : answer.length;
    const content = answer.slice(start, end).replace(/\s*\|\s*$/, "").trim();
    if (content) result.set(label, content);
  }
  return result;
}

/**
 * Build the answer description string for the marking prompt.
 * When an answer image is present, explicitly spells out per sub-part
 * whether to mark against TEXT or against the IMAGE. A sub-part is
 * "image-only" when its text value is empty or is a placeholder like
 * "see image" / "see diagram" / "refer to figure". All other sub-parts
 * have a text answer and MUST be marked against that text only — the
 * answer image is not relevant to those parts.
 */
function buildAnswerDesc(answer: string | null, hasImage: boolean): string {
  if (!hasImage) return answer ? `"${answer}"` : "not provided";

  const partMap = parsePartAnswers(answer);
  const seeImageRe = /^\s*(?:see|refer to)\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b.*$/i;

  // If the answer is genuinely multi-part, build an explicit per-part
  // routing table so the AI can't mistakenly apply the image to a text
  // sub-part (which is what was happening: "(a) see answer image (b) 42"
  // was being marked with the AI comparing the student's (b) against
  // the answer image).
  if (partMap.size > 0) {
    const rows: string[] = [];
    for (const [label, text] of [...partMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const isImagePart = !text.trim() || seeImageRe.test(text);
      if (isImagePart) {
        rows.push(`    - (${label}) → compare student's drawing against the ANSWER IMAGE provided below.`);
      } else {
        rows.push(`    - (${label}) → compare student's blue ink against the TEXT answer: "${text}". DO NOT use the answer image for this part.`);
      }
    }
    return `Multi-part answer — routing per sub-part:
${rows.join("\n")}

RULES:
    - The ADDITIONAL IMAGE is ONLY ground truth for sub-parts listed above as "ANSWER IMAGE". For every other sub-part, the TEXT answer is the only ground truth — the answer image is NOT relevant to those parts and must NOT be used to contradict the text key.
    - NEVER use the image to mark a sub-part that already has a text answer in the key.
    - NEVER use the text key to mark a sub-part that is routed to the image.`;
  }

  // Single-part fallback (no (a)/(b) labels detected): keep the older
  // phrasing so drawing-only questions still work.
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
  - MCQ questions (Grammar MCQ, Vocabulary MCQ): no partial marks, exact single-option match only.
  - For ALL written English questions, READ the question text in the image to identify the question type, then apply the rules below.
  - The sections in order after MCQ are: (a) Grammar Cloze, (b) Editing, (c) Comprehension Cloze, (d) Synthesis & Transformation, (e) Comprehension OEQ.

  (a) GRAMMAR CLOZE (select from options A–Q, excluding I and O):
  - A passage with numbered blanks. The student selects a word from a printed word bank labeled A through Q (letters I and O are skipped to avoid confusion with numbers 1 and 0).
  - The student writes a SINGLE LETTER (A–H, J–N, P–Q) in the blank or answer box.
  - STEP 1 — Verify question number: locate the parenthesised number and confirm it matches the question you are marking.
  - STEP 2 — Blue ink check: look for blue ink written ON or ABOVE the blank or in the answer box. If no blue ink, award 0.
  - STEP 3 — Read answer: the student's answer is the LETTER written in blue ink. Read it as an uppercase letter (A–Q).
  - Compare the letter against the answer key. Exact letter match = full marks. Wrong letter = 0 marks.
  - NOTE: The letters I and O are NOT used. If you think you see "I" it is likely "J"; if you see "O" it is likely "D", "Q", or "C". Use context and the letter bank to resolve ambiguity.

  (b) EDITING (spelling & grammar correction):
  - The question number is printed BESIDE an answer box. The passage nearby contains an UNDERLINED or MARKED word — this is the erroneous word the student must correct.
  - STEP 1 — Verify question number: locate the printed question number and confirm it matches the question you are marking.
  - STEP 2 — Read the underlined error word: find the underlined/marked word in the printed passage near this question number. Read it carefully. This tells you WHAT KIND of error the student was asked to fix (e.g. a misspelling, wrong tense, wrong form). Log it: "Error word: [word]".
  - STEP 3 — Blue ink check: confirm there is blue ink written INSIDE the answer box. If no blue ink, award 0 marks.
  - STEP 4 — Transcribe letter by letter: spell out EVERY letter of the handwritten blue-ink word, one at a time. Write as "x-x-x-x-x". Do NOT infer or guess the word — transcribe only what the ink physically shows, stroke by stroke. Log it: "Transcription: [x-x-x-x-x]".
  - STEP 5 — Cross-check against the error word: if the error word looks like a misspelling of the expected answer (e.g. error word is "beleive", expected is "believe"), the student's answer is VERY LIKELY a near-miss spelling attempt. In this case, apply MAXIMUM strictness — even one wrong or missing letter = 0.
  - STEP 6 — Count letters: count letters in your transcription vs expected answer. If counts differ, immediately award 0 (do NOT show letter count in notes).
  - STEP 7 — Compare position by position: for each position, confirm the letter matches exactly. One mismatch = 0.
  - STEP 8 — Award marks only if every letter matches exactly.
  - ALWAYS output this in notes (even for correct answers): "Error word: X | Transcription: x-x-x-x | Match: YES/NO".

  (c) COMPREHENSION CLOZE (fill-in-the-blank, no word bank):
  - A passage with numbered blanks. The student must fill in a suitable word based on context (no options given).
  - The question number is printed in parentheses BELOW the blank line, e.g. (34).
  - STEP 1 — Verify question number: locate the parenthesised number e.g. "(34)" in the crop and confirm it matches the question you are marking. If multiple question numbers are visible, only read the answer for the matching number.
  - STEP 2 — Blue ink check: look for blue ink written ON or ABOVE the blank line that is directly above the matching parenthesised number. If no blue ink is found there, award 0 marks.
  - STEP 3 — Read answer: the student's answer is the word written in blue ink on/above the blank paired with the matching number. Do NOT read a word from a different blank belonging to a different number.
  - Accept the exact word from the answer key. Accept clear synonyms ONLY if semantically equivalent in context and grammatically correct in the sentence.
  - Do NOT accept answers that change the grammar of the sentence.
  - Spelling must be correct. A misspelled word = 0 marks.

  (d) SYNTHESIS & TRANSFORMATION (sentence rewriting):
  - There is usually one correct rewritten sentence or one accepted form.
  - Award full marks only if the answer is grammatically correct AND preserves the original meaning.
  - Award 0 if meaning is changed, tense is wrong, or key words are missing.
  - Minor spelling errors that do not change the word: still award marks.
  - The given word/phrase MUST be used in the rewritten sentence. If the student did not use the given word, award 0.

  (e) COMPREHENSION OEQ (open-ended, short answer):
  - The answer key gives the expected key point(s).
  - Award full marks if all key points are present in the student's answer.
  - Award PARTIAL marks if some key points are present — even for 1-mark questions, award 0 if the key idea is missing or too vague.
  - Accept synonyms and paraphrases as long as the meaning is preserved.
  - In notes, state which key point was present or missing.`;
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
  - All other command words (Name, Give, Identify, etc.): treat like "State" — short, specific answer expected.

  KEY TERM EMPHASIS IN NOTES (Science only):
  - Identify the specific scientific key terms required by the answer (e.g. "photosynthesis", "potential energy", "evaporation", "chlorophyll").
  - If the student's answer is missing one or more of these key terms, wrap each missing term in **double asterisks** in the notes field.
  - Example: "Student described the process correctly but did not use the term **photosynthesis**. The word **chlorophyll** was also absent."
  - Only bold terms that are genuinely absent from the student's answer — do not bold terms the student did use.`;
}

function mathMarkingRules(subject: string | null | undefined): string {
  if (!subject?.toLowerCase().includes("math")) return "";
  return `
  MATH OPEN-ENDED MARKING RULES (applies to this Mathematics paper only):
  - For each written (non-MCQ) question, FIRST locate the "Ans:" or "Answer:" line at the BOTTOM-RIGHT of the question's answer region.
    This is a printed line followed by a blank — the student writes their final answer on or above this line in blue ink.
  - Read the blue ink written on/above the "Ans:" line as the student's FINAL ANSWER.
  - If the final answer matches the expected answer → award FULL MARKS immediately. Do NOT penalise for missing or incomplete working.
  - ONLY if the final answer does NOT match the expected answer (or is absent): scan the student's working steps for partial credit.
    Award partial marks if some steps or methods are correct, proportional to marksAvailable.
  - If no "Ans:" line is visible, use the last clearly written blue-ink answer in the response area as the final answer.
  - CONCEPT ERRORS: If the student used the wrong formula, method, or operation, wrap the specific error in **double asterisks** in the notes (e.g. "Student used **multiplication** instead of division" or "Wrong formula: used **P = 2l + w** instead of area formula").`;
}

const MARKING_PROMPT = `You are marking a primary school student's exam submission. Be concise. Use British English throughout (e.g. "colour", "centre", "recognised").

CRITICAL — DEGREE SYMBOL: ONLY if the expected answer literally contains the ° character (e.g. "8°", "45°"), then accept "80" or "450" as correct — the trailing 0 is a misread degree symbol. If the expected answer does NOT contain ° (e.g. just "8" or "80"), do NOT apply this rule. In the notes, write: "Trailing 0 interpreted as degree symbol (°) — answer accepted as X°."

CRITICAL — DIGIT "1": A child's handwritten "1" is often just a single thin vertical stroke (|) with no serif or base. It is easily missed next to other digits. E.g. "51cm" must NOT be read as "5cm". If your detected answer has fewer digits than the expected answer, re-examine the handwriting for missed "1"s.

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
  - MULTI-DIGIT NUMBERS: Read ALL digits carefully. A "1" can look like a thin vertical stroke and is easily missed between or before other digits. For example, "51" must not be read as just "5" — look closely for a thin stroke before/after each digit. Count the number of digits you see and cross-check against the expected answer's digit count. If the expected answer has 2+ digits, make sure you are reading all of them.
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
     - DEGREE SYMBOL: ONLY if the expected answer literally contains ° (e.g. "8°", "45°"), then "80" or "450" match — the trailing 0 is a misread degree symbol. Do NOT apply if expected answer has no °. In notes, write: "Trailing 0 interpreted as degree symbol (°) — answer accepted as X°."
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
    - DEGREE SYMBOL: In geometry/angle questions, the degree symbol (°) in handwriting looks like a small zero, circle, or dot written ABOVE and to the RIGHT of the number (superscript position). Do NOT read it as a trailing digit "0". For example, "8°" must NOT be read as "80" — the small raised circle is a degree symbol. If the expected answer contains degrees (e.g. "45°", "8°") and you see a small circle/zero-like mark in superscript position after a number, it is the degree symbol. Write the answer with ° (e.g. "8°", "45°", "120°").
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
  - BOLD ERRORS: Use **double asterisks** to highlight the specific concept, keyword, or term the student got wrong or missed. E.g. "Student used **subtraction** instead of **division**." or "Missing key term: **photosynthesis**." Bold only the specific wrong/missing item, not the whole sentence.

FINAL REMINDER — READ THIS BEFORE RESPONDING:
  1. For EVERY question, your FIRST action must be checking for blue ink within its yStart%–yEnd% region.
  2. NEVER read ink outside a question's yStart%–yEnd% boundaries. Content outside = invisible.
  3. If a question's region has NO blue handwritten ink → marksAwarded: 0, studentAnswer: "No answer detected".
  4. Printed black text (even if it matches the expected answer) is NOT the student's answer.
  5. Do NOT hallucinate or invent answers. Only report what is actually handwritten in blue ink WITHIN boundaries.
  6. For answer image questions: ONLY compare against what is visible in the provided answer image. Never guess or infer the correct answer from context.
  7. Blue ink present ≠ correct answer. If blue ink exists but is too incomplete/illegible to match the expected answer, award 0 marks. Do NOT assume the student wrote the correct answer just because some blue ink is there.
  8. NEVER copy the answer key into studentAnswer. studentAnswer must only contain what you actually saw written in blue ink. If a sub-part answer was not detected, say "(x) missing" — never substitute the expected answer.
  9. GEOMETRY/ANGLE QUESTIONS: If the expected answer contains a degree symbol (°), a small raised circle or zero-like mark after the student's number is the DEGREE SYMBOL, not the digit "0". E.g. student writes "8°" → read as "8°" NOT "80". Always check the expected answer for ° before interpreting trailing marks.

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
      if (masterQ.syllabusTopic !== question.syllabusTopic) updates.syllabusTopic = masterQ.syllabusTopic;
      if (Object.keys(updates).length > 0) {
        await prisma.examQuestion.update({ where: { id: question.id }, data: updates });
        Object.assign(question, updates);
        console.log(`[marking] Synced question ${question.questionNum} from master`);
      }
    }
  }

  const subDir = path.join(SUBMISSIONS_DIR, paper.id);

  // Compute submissionIndexMap the same way as markExamPaper
  const metadata = paper.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
  const hiddenPageSet = new Set([
    ...(metadata?.answerPages ?? []).map((p: number) => p - 1),
    ...(metadata?.skipPages ?? []).map((p: number) => p - 1),
  ]);
  let submissionIdx = 0;
  let submissionPage = -1;
  for (let i = 0; i < paper.pageCount; i++) {
    if (!hiddenPageSet.has(i)) {
      if (i === question.pageIndex) { submissionPage = submissionIdx; break; }
      submissionIdx++;
    }
  }
  if (submissionPage === -1) {
    console.error(`[marking] remarkSingle Q${question.questionNum}: pageIndex=${question.pageIndex} is in hiddenPageSet or out of range (pageCount=${paper.pageCount}, hiddenPageSet=[${[...hiddenPageSet].join(",")}])`);
    throw new Error("Question page not in submission");
  }

  const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
  const pageBuffer = await fs.readFile(pagePath);

  // MCQ: use blind detection (no expected answer shown to AI)
  // Cloze questions are always written even if their answer field is a single letter
  if (isMcqAnswer(question.answer) && !isClozeQuestion(question.syllabusTopic)) {
    // Crop to question region to prevent adjacent questions bleeding in
    const hasBounds = question.yStartPct != null && question.yEndPct != null;
    const mcqImageBuffer = hasBounds
      ? await cropPageRegion(pageBuffer, question.yStartPct!, question.yEndPct!, `remarkSingle MCQ Q${question.questionNum}`)
      : pageBuffer;
    const pageBase64 = mcqImageBuffer.toString("base64");
    const qForDetect = hasBounds ? { ...question, yStartPct: 0, yEndPct: 100 } : question;
    const isAnswer1 = normalizeMcq(question.answer ?? "") === "1";
    let studentAnswer: string | null = null;

    if (isAnswer1) {
      // 1 normal + 1 OpenCV-enhanced — if either detects "1", accept it
      console.log(`[marking] remarkSingle MCQ Q${question.questionNum}: answer=1, normal + opencv`);
      const enhancedBuffer = await isolateAndThickenBlueInk(mcqImageBuffer, `remarkSingle Q${question.questionNum}`);
      const enhancedBase64 = enhancedBuffer.toString("base64");

      const hint1 = new Set([question.id]);
      const [normalDet, opencvDet] = await Promise.all([
        detectMcqAnswers(pageBase64, [qForDetect], `remarkSingle Q${question.questionNum} normal`, 0.4, hint1),
        detectMcqAnswers(enhancedBase64, [qForDetect], `remarkSingle Q${question.questionNum} opencv`, 0.3, hint1),
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
      const detected = await detectMcqAnswers(pageBase64, [qForDetect], `remarkSingle Q${question.questionNum}`);
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
  // Cloze questions are always treated as written regardless of answer field
  const useCrop = (isWrittenQuestion(question.answer) || isClozeQuestion(question.syllabusTopic))
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
        data: { marksAwarded: 0, markingNotes: "Detected: No answer detected | No written answer found" },
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

  const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject));
  parts.push({ text: prompt });

  const isCloze = question.syllabusTopic === "Grammar Cloze" || question.syllabusTopic === "Comprehension Cloze";
  const isEditing = question.syllabusTopic === "Editing (Spelling & Grammar)";
  const remarkModel = (isCloze || isEditing) ? "gemini-3.1-flash-lite-preview" : "gemini-2.5-flash";
  if (isEditing) console.log(`[marking] Q${question.questionNum} is Editing (Spelling & Grammar) — applying strict letter-by-letter spell check (model: gemini-3.1-flash-lite-preview)`);
  console.log(`[marking] Calling Gemini (${remarkModel}) for remark of question ${questionId} (syllabusTopic="${question.syllabusTopic ?? "none"}")`);
  const response = await withTimeout(
    getAI().models.generateContent({
      model: remarkModel,
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
    // Answer pages and skip pages (from metadata) are not included in the submission files
    const metadata = paper.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
    const hiddenPageSet = new Set([
      ...(metadata?.answerPages ?? []).map((p: number) => p - 1),
      ...(metadata?.skipPages ?? []).map((p: number) => p - 1),
    ]);
    const submissionIndexMap = new Map<number, number>();
    let submissionIdx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!hiddenPageSet.has(i)) submissionIndexMap.set(i, submissionIdx++);
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
      isCropped: boolean,
      modelOverride?: string
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

      const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper?.subject) + mathMarkingRules(paper?.subject) + englishMarkingRules(paper?.subject));

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
            model: modelOverride ?? "gemini-2.5-flash",
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
        // Cloze questions are always treated as written regardless of answer field
        const writtenQs = questions.filter((q) => (isWrittenQuestion(q.answer) || isClozeQuestion(q.syllabusTopic)) && q.yStartPct != null && q.yEndPct != null);
        const otherQs = questions.filter((q) => !writtenQs.includes(q));

        // Further split otherQs into MCQ (blind detection) and non-MCQ (normal marking)
        // Cloze questions are excluded from MCQ detection even if their answer is a single letter
        const mcqQs = otherQs.filter((q) => isMcqAnswer(q.answer) && !isClozeQuestion(q.syllabusTopic));
        const nonMcqOther = otherQs.filter((q) => !isMcqAnswer(q.answer) || isClozeQuestion(q.syllabusTopic));

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

        // Blind MCQ detection: one question at a time, cropped to question region to avoid cross-contamination
        if (mcqQs.length > 0) {
          console.log(`[marking] ── MCQ BLIND DETECTION ── page ${pageIndex}, ${mcqQs.length} questions (1-by-1, cropped): ${mcqQs.map(q => `Q${q.questionNum}(ans=${q.answer})`).join(", ")}`);
          const mcqResults = await Promise.all(
            mcqQs.map(async (q) => {
              // Crop to question region to prevent adjacent question answers bleeding in
              const hasBounds = q.yStartPct != null && q.yEndPct != null;
              const imageBuffer = hasBounds
                ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `MCQ page ${pageIndex} Q${q.questionNum}`)
                : pageBuffer;
              const imageBase64 = imageBuffer.toString("base64");
              const qForDetect = hasBounds ? { ...q, yStartPct: 0, yEndPct: 100 } : q;
              const detected = await detectMcqAnswers(imageBase64, [qForDetect], `page ${pageIndex} Q${q.questionNum}`);
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

        // Individual cropped calls for written questions (all subjects) with blue ink pre-check
        if (writtenQs.length > 0) {
          console.log(`[marking] Cropping ${writtenQs.length} written questions on page ${pageIndex}`);
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
                    notes: "No written answer found",
                  }] as QuestionMarkResult[];
                }

                // Step 2: Mark normally with cropped image
                const isCloze = q.syllabusTopic === "Grammar Cloze" || q.syllabusTopic === "Comprehension Cloze";
                const isEditing = q.syllabusTopic === "Editing (Spelling & Grammar)";
                const batchModel = (isCloze || isEditing) ? "gemini-3.1-flash-lite-preview" : "gemini-2.5-flash";
                if (isEditing) console.log(`[marking] Q${q.questionNum} is Editing (Spelling & Grammar) — applying strict letter-by-letter spell check (model: gemini-3.1-flash-lite-preview)`);
                console.log(`[marking] Q${q.questionNum} using model: ${batchModel} (syllabusTopic="${q.syllabusTopic ?? "none"}")`);
                return markBatch(croppedBase64, [q], `page ${pageIndex} Q${q.questionNum} (cropped)`, true, (isCloze || isEditing) ? "gemini-3.1-flash-lite-preview" : undefined);
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
          if (isMcqAnswer(q.answer) && !isClozeQuestion(q.syllabusTopic)) {
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
                notes: "No written answer found",
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
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject));
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
      if (r.notes?.includes("No written answer found")) return false;
      // Skip MCQ — blind detection is already unbiased, re-detection unlikely to differ
      if (isMcqAnswer(q.answer) && !isClozeQuestion(q.syllabusTopic)) return false;
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
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject));
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
      if (!isMcqAnswer(q.answer) || isClozeQuestion(q.syllabusTopic)) return false;
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

    // Auto-generate summary if instantFeedback is enabled (paper stays "complete" for parent review)
    if (paper.instantFeedback) {
      console.log(`[marking] instantFeedback=true — auto-generating summary for ${paperId}`);
      try {
        await generateFeedbackSummary(paperId);
      } catch (err) {
        console.error(`[marking] Auto-summary failed for ${paperId}:`, err);
      }
    }

    // Auto-release if 100% score and student has skipReviewPerfect enabled
    const examTotalAvailable = [...validResults.values()].reduce((s, r) => s + (r.marksAvailable ?? 0), 0);
    if (examTotalAvailable > 0 && totalAwarded >= examTotalAvailable && paper.assignedToId) {
      const student = await prisma.user.findUnique({ where: { id: paper.assignedToId }, select: { settings: true } });
      const sSettings = (student?.settings ?? {}) as Record<string, unknown>;
      if (sSettings.skipReviewPerfect === true) {
        await prisma.examPaper.update({ where: { id: paperId }, data: { markingStatus: "released" } });
        console.log(`[marking] Paper ${paperId} auto-released (100% score, skipReviewPerfect=true)`);
      }
    }
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

  const feedbackPrompt = `You are writing a short feedback summary for a primary school student's exam, aimed at helping them know what to revise. Use British English throughout.
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

const FOCUSED_MARKING_PROMPT = `You are marking a primary school student's handwritten answer for a math/science question. Be concise. Use British English throughout (e.g. "colour", "centre", "recognised").

HOW TO READ THE IMAGES:
- Image 1: The printed question.
- Image 2: The student's handwritten answer (blue ink on white paper).
{ANSWER_IMAGE_NOTE}

Marks available: {MARKS_AVAILABLE}

CRITICAL — DEGREE SYMBOL: ONLY if the expected answer literally contains the ° character (e.g. "8°", "45°"), then accept "80" or "450" as correct — the trailing 0 is a misread degree symbol. If the expected answer does NOT contain ° (e.g. just "8" or "80"), do NOT apply this rule. In the notes, write: "Trailing 0 interpreted as degree symbol (°) — answer accepted as X°."

CRITICAL — DIGIT "1": A child's handwritten "1" is often just a single thin vertical stroke (|) with no serif or base. It is easily missed next to other digits. Read EVERY digit carefully. E.g. "51cm" must NOT be read as "5cm" — look for a thin vertical stroke before or after other digits. If the expected answer has more digits than what you detected, re-examine the handwriting for missed "1"s.

CRITICAL — GRID / DIAGRAM DRAWINGS:
- When the answer involves drawing on a grid (e.g. plotting points, drawing shapes, completing figures), do NOT try to extract exact coordinates. Instead, compare the student's drawing VISUALLY against the expected answer image.
- If the drawn point or shape is in the correct position on the grid (matching the answer image), award full marks. A point drawn slightly off-center within the correct grid cell still counts as correct.
- Focus on whether the student understood the concept, not pixel-perfect placement.
- SYMMETRY / MULTIPLE SOLUTIONS: For questions asking to shade squares, draw lines of symmetry, or complete patterns — there may be MULTIPLE valid solutions. The answer image shows ONE valid answer. If the student's answer is DIFFERENT but still satisfies the question requirement (e.g. produces a valid line of symmetry), award FULL MARKS. Check the student's answer against the QUESTION REQUIREMENT, not just the answer image.
- "See answer image" answers: When the text answer says "see answer image" or similar, you MUST evaluate the student's drawing by checking if it satisfies the question's requirements. If the student's drawing is correct (even if it differs from the answer image), award full marks.

╔══════════════════════════════════════════════════════════════════════╗
║  ANTI-BIAS: You MUST read the student's answer INDEPENDENTLY        ║
║  from the image BEFORE comparing to the expected answer below.      ║
║  Report EXACTLY what the student wrote — even if it differs from    ║
║  the expected answer. Do NOT let the expected answer influence       ║
║  what you read from the image. If the student wrote "False" but     ║
║  the answer key says "True", you MUST report "False".               ║
╚══════════════════════════════════════════════════════════════════════╝

Instructions:
1. FIRST — Read the student's blue-ink handwritten answer from Image 2. Write down EXACTLY what you see. Do NOT look at the expected answer yet.
2. If the question has multiple sub-parts labelled (a), (b), (c) etc., you MUST mark EACH sub-part separately. The expected answer may contain all parts on one line (e.g. "(a) 12 cm (b) 25 cm") or separated — extract each sub-part from it. For every labelled sub-part in the question, give a separate award and note. If the expected answer only lists one sub-part, still report on the other sub-parts as "(x) no answer key provided" and award them 0 — never skip them silently. Split the total marks across sub-parts as fairly as possible.
3. NOW compare the student's FINAL ANSWER against the expected answer:
   Expected answer: {EXPECTED_ANSWER}
   - If the final answer is correct → award FULL MARKS immediately. Do NOT check or penalise working steps. Working does not matter when the final answer is right.
   - ONLY if the final answer is WRONG or absent: check working/steps for partial credit → award PARTIAL marks if some steps are correct.
   - If wrong with no correct working → ZERO marks.
   - For MCQ (single option answer): no partial marks.
4. Record what you detected.

Return ONLY valid JSON (no markdown fences):
{"questionId": "{QUESTION_ID}", "marksAvailable": {MARKS_AVAILABLE}, "marksAwarded": <number>, "studentAnswer": "<what the student ACTUALLY wrote — for multi-part: (a) ... (b) ...>", "notes": "<for multi-part questions, give feedback per sub-part, e.g. '(a) Correct. (b) Wrong — should be 3/4 not 2/3.'>"}`;

export async function markFocusedTest(paperId: string): Promise<void> {
  console.log(`[focused-marking] Starting for ${paperId} — delegating to markQuizPaper`);
  // Unified marking: focused tests and quizzes use the same code path (markQuizPaper).
  // For English, typed-section logic applies; for Math/Science, it's no-op.
  // This ensures any marking fix applies to both quiz and focused test automatically.
  return markQuizPaper(paperId);
}

// Legacy focused-test marking code — kept only as fallback reference, no longer called.
async function _legacyMarkFocusedTest(paperId: string): Promise<void> {
  const paperKind = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { metadata: true },
  });
  const hasEnglishSections = !!(paperKind?.metadata as { englishSections?: unknown } | null)?.englishSections;
  if (hasEnglishSections) {
    return markQuizPaper(paperId);
  }

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

    // Separate MCQ (already marked client-side) and OEQ (need AI marking with submission images)
    const isMcqQ = (answer: string | null) => {
      const n = (answer ?? "").trim().replace(/[().]/g, "").trim();
      return n === "1" || n === "2" || n === "3" || n === "4";
    };

    const mcqQuestions = paper.questions.filter(q => isMcqQ(q.answer));
    const oeqQuestions = paper.questions.filter(q => !isMcqQ(q.answer));

    let totalAwarded = mcqQuestions.reduce((sum, q) => sum + (q.marksAwarded ?? 0), 0);
    const updates: ReturnType<typeof prisma.examQuestion.update>[] = [];

    if (oeqQuestions.length === 0) {
      // All MCQ — just finalise
      await prisma.$transaction([
        prisma.examPaper.update({
          where: { id: paperId },
          data: { score: totalAwarded, markingStatus: "complete" },
        }),
      ]);
      await generateFeedbackSummary(paperId);
      console.log(`[focused-marking] Paper ${paperId} done (MCQ only). Score: ${totalAwarded}`);
      return;
    }

    const subDir = path.join(SUBMISSIONS_DIR, paperId);
    const ai = getAI();

    for (let i = 0; i < oeqQuestions.length; i++) {
      const q = oeqQuestions[i];
      const expectedAnswer = q.answer || "?";
      const marksAvailable = q.marksAvailable ?? 1;

      // Students open focused tests via /quiz/[id] (the quiz page). The quiz page
      // uploads OEQ canvases at the OEQ-sequential index (page_0..page_{n-1} where
      // n = number of OEQ questions), so we read at `i` to match.
      const submissionIndex = i;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];

      // Question text from transcribed stem
      if (q.transcribedStem) {
        let questionText = `Question: ${q.transcribedStem}`;
        const subparts = q.transcribedSubparts as { label: string; text: string }[] | null;
        if (subparts && subparts.length > 0) {
          const subpartTexts = subparts
            .filter(sp => !sp.label.startsWith("_"))
            .map(sp => `(${sp.label}) ${sp.text}`);
          questionText += "\n" + subpartTexts.join("\n");
        }
        parts.push({ text: questionText });
      }

      // Question image (from DB)
      if (q.imageData && q.imageData.startsWith("data:image")) {
        const match = q.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          parts.push({ text: "Question image:" });
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }

      // Student's handwritten answer — follow the same flow as quiz OEQ marking:
      // 1. try the composite JPG (background + ink)
      // 2. fall back to the ink-only PNG if composite is missing
      // 3. do a blue-ink pre-check so questions with no drawing are cleanly tagged "No answer detected"
      let hasSubmission = false;
      let submissionBase64: string | null = null;
      let submissionMime: "image/jpeg" | "image/png" = "image/jpeg";
      try {
        const pagePath = path.join(subDir, `page_${submissionIndex}.jpg`);
        const pageBuffer = await fs.readFile(pagePath);
        submissionBase64 = pageBuffer.toString("base64");
        submissionMime = "image/jpeg";
        hasSubmission = true;
      } catch {
        // fall through to ink-only PNG
      }
      if (!hasSubmission) {
        try {
          const inkPath = path.join(subDir, `page_${submissionIndex}_ink.png`);
          const inkBuffer = await fs.readFile(inkPath);
          submissionBase64 = inkBuffer.toString("base64");
          submissionMime = "image/png";
          hasSubmission = true;
        } catch {
          // truly nothing on disk for this question
        }
      }

      // Blue-ink pre-check — if we have a file but it's visually blank, treat as no answer
      if (hasSubmission && submissionBase64) {
        const inkFound = await hasBlueInk(submissionBase64, `focused-q${q.questionNum}`, submissionMime);
        if (!inkFound) {
          console.log(`[focused-marking] Q${q.questionNum}: pre-check found no ink — marking 0`);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, studentAnswer: "No answer detected", markingNotes: "No written answer found" },
            })
          );
          continue;
        }

        // For multi-part questions, send per-subpart images so the AI sees each answer clearly
        const realSubs = (q.transcribedSubparts as { label: string; text: string }[] | null)?.filter(sp => !sp.label.startsWith("_")) ?? [];
        let usedSubpartImages = false;
        if (realSubs.length > 0) {
          for (const sp of realSubs) {
            try {
              const spPath = path.join(subDir, `page_${submissionIndex}_${sp.label}.jpg`);
              const spBuffer = await fs.readFile(spPath);
              parts.push({ text: `Student's handwritten answer for part (${sp.label}):` });
              parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: spBuffer.toString("base64") } });
              usedSubpartImages = true;
            } catch { /* subpart file not found, will fall back */ }
          }
        }
        if (!usedSubpartImages) {
          parts.push({ text: "Student's handwritten answer:" });
          parts.push({ inlineData: { mimeType: submissionMime, data: submissionBase64 } });
        }
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

/**
 * Mark a quiz paper (paperType === "quiz").
 * MCQ questions should already have marksAwarded set by the client.
 * OEQ questions are marked via AI using their submission drawings.
 */
export async function markQuizPaper(paperId: string): Promise<void> {
  console.log(`[quiz-marking] Starting for ${paperId}`);

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

    // Sync answers from source questions (in case answer keys were updated).
    // For multi-part merged questions (e.g. focused Q6 whose source was Q12ab + Q12c),
    // fetch ALL sibling source rows and rebuild per-part answers — otherwise we'd
    // overwrite the merged answer with just one source row's partial answer.
    const sourceIds = paper.questions.map(q => q.sourceQuestionId).filter(Boolean) as string[];
    if (sourceIds.length > 0) {
      const sourceQuestions = await prisma.examQuestion.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, answer: true, answerImageData: true, questionNum: true, examPaperId: true },
      });
      const sourceMap = new Map(sourceQuestions.map(sq => [sq.id, sq]));

      // For each unique (examPaperId, baseNum), fetch all siblings once
      type Sib = { questionNum: string; answer: string | null; answerImageData: string | null; transcribedSubparts: Prisma.JsonValue; transcribedStem: string | null };
      const siblingCache = new Map<string, Array<Sib>>();
      const baseNumOf = (n: string) => n.replace(/[a-zA-Z]+$/, "");
      const uniqueKeys = new Set<string>();
      for (const sq of sourceQuestions) uniqueKeys.add(`${sq.examPaperId}::${baseNumOf(sq.questionNum)}`);
      for (const key of uniqueKeys) {
        const [examPaperId, base] = key.split("::");
        const sibs = await prisma.examQuestion.findMany({
          where: { examPaperId, questionNum: { startsWith: base } },
          select: { questionNum: true, answer: true, answerImageData: true, transcribedSubparts: true, transcribedStem: true },
        });
        siblingCache.set(key, sibs);
      }

      for (const q of paper.questions) {
        if (!q.sourceQuestionId) continue;
        const src = sourceMap.get(q.sourceQuestionId);
        if (!src) continue;

        type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };
        const subs = (q.transcribedSubparts as Subpart[] | null) ?? null;
        const realSubs = (subs ?? []).filter(s => !s.label.startsWith("_"));

        if (realSubs.length > 0) {
          // Multi-part question — aggregate per-part answers across all source siblings
          const siblings = siblingCache.get(`${src.examPaperId}::${baseNumOf(src.questionNum)}`) ?? [];
          const partAnswers = new Map<string, string>();
          for (const sib of siblings) {
            const parsed = parsePartAnswers(sib.answer);
            if (parsed.size > 0) {
              for (const [label, text] of parsed) partAnswers.set(label, text);
              continue;
            }
            // No explicit (a)/(b) markers. If this sibling has exactly one real
            // subpart, attribute the whole answer to that subpart's label.
            const sibSubs = (sib.transcribedSubparts as Subpart[] | null) ?? [];
            const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
            if (sibRealSubs.length === 1 && sib.answer?.trim()) {
              partAnswers.set(sibRealSubs[0].label.toLowerCase(), sib.answer.trim());
            }
          }
          // Pick the first sibling with an answer image (in questionNum order)
          const sortedSibs = [...siblings].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
          const answerImg = sortedSibs.find(s => s.answerImageData)?.answerImageData ?? null;

          // Build a map of extra scenario context per subpart label. When a source
          // sibling has its own stem (different from the first sibling's), that
          // stem is added context for the subparts in that sibling — e.g. Q38cd
          // "Xiao Ming noticed the inner surface… was wet" applies only to (c)/(d).
          const firstSibStem = (sortedSibs[0]?.transcribedStem ?? "").trim();
          const extraStemFor = new Map<string, string>();
          for (const sib of sortedSibs) {
            const sibStem = (sib.transcribedStem ?? "").trim();
            if (!sibStem || sibStem === firstSibStem) continue;
            const sibSubs = (sib.transcribedSubparts as Subpart[] | null) ?? [];
            const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
            if (sibRealSubs.length === 0) continue;
            const firstLabel = sibRealSubs[0].label.toLowerCase();
            if (!extraStemFor.has(firstLabel)) extraStemFor.set(firstLabel, sibStem);
          }

          // Build new subparts with sp.answer attached and any extra stem prepended.
          // We preserve whatever prepending already happened (idempotent check).
          const newSubs = (subs ?? []).map(sp => {
            if (sp.label.startsWith("_")) return sp;
            const ans = partAnswers.get(sp.label.toLowerCase());
            let next = ans !== undefined ? { ...sp, answer: ans } : { ...sp };
            const extra = extraStemFor.get(sp.label.toLowerCase());
            if (extra && !(sp.text ?? "").includes(extra)) {
              next = { ...next, text: `${extra}\n\n${sp.text ?? ""}`.trim() };
            }
            return next;
          });
          // Rebuild combined answer from part answers (preserves all parts)
          const combined = [...partAnswers.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `(${k}) ${v}`)
            .join(" | ");
          const newAnswer = combined || q.answer;
          const subsChanged = JSON.stringify(newSubs) !== JSON.stringify(subs);
          if (newAnswer !== q.answer || answerImg !== q.answerImageData || subsChanged) {
            console.log(`[quiz-marking] Rebuilding multi-part answer for Q${q.questionNum} from ${siblings.length} siblings`);
            await prisma.examQuestion.update({
              where: { id: q.id },
              data: {
                answer: newAnswer,
                answerImageData: answerImg,
                transcribedSubparts: newSubs as unknown as Prisma.InputJsonValue,
              },
            });
            q.answer = newAnswer;
            q.answerImageData = answerImg;
            q.transcribedSubparts = newSubs as unknown as typeof q.transcribedSubparts;
          }
        } else if (src.answer !== q.answer || src.answerImageData !== q.answerImageData) {
          // Single-part question — simple sync
          console.log(`[quiz-marking] Syncing answer for Q${q.questionNum}: "${q.answer}" → "${src.answer}"`);
          await prisma.examQuestion.update({
            where: { id: q.id },
            data: { answer: src.answer, answerImageData: src.answerImageData },
          });
          q.answer = src.answer;
          q.answerImageData = src.answerImageData;
        }
      }
    }

    // Identify typed English section questions (Grammar Cloze, Editing, Comp Cloze, Visual Text MCQ)
    // These are scored by direct comparison, not AI marking
    const typedSectionQIds = new Set<string>();
    const meta = paper.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> } | null;
    if (meta?.englishSections) {
      for (const sec of meta.englishSections) {
        const label = sec.label.toLowerCase();
        const isTyped = label.includes("grammar cloze") || label.includes("editing") ||
          label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze")) ||
          label.includes("visual text");
        if (isTyped) {
          for (let i = sec.startIndex; i <= sec.endIndex && i < paper.questions.length; i++) {
            typedSectionQIds.add(paper.questions[i].id);
          }
        }
      }
    }

    // Separate MCQ (has options) and OEQ (need AI marking).
    // Use options-based classification (same as quiz page) — NOT answer format.
    const hasOpts = (q: typeof paper.questions[0]) => {
      const opts = q.transcribedOptions as unknown[] | null;
      const imgs = q.transcribedOptionImages as unknown[] | null;
      if (Array.isArray(opts) && opts.length === 4) return true;
      if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
      return false;
    };
    const mcqQuestions = paper.questions.filter(q => hasOpts(q) || typedSectionQIds.has(q.id));
    const oeqQuestions = paper.questions.filter(q => !hasOpts(q) && !typedSectionQIds.has(q.id) && q.studentAnswer !== "__SKIPPED__");

    // English-only typed OEQ sections (synthesis, comprehension OEQ) — these store the
    // student's answer as typed text in studentAnswer. All other OEQ questions (math,
    // science, English written) use the canvas image on disk, regardless of what
    // studentAnswer currently contains (may be a stale "No answer detected" from a
    // previous marking run).
    const aiTypedOeqQIds = new Set<string>();
    if (meta?.englishSections) {
      for (const sec of meta.englishSections) {
        const label = sec.label.toLowerCase();
        const isAiTyped = label.includes("synthesis") ||
          (label.includes("comprehension") && (label.includes("oeq") || label.includes("open")));
        if (isAiTyped) {
          for (let i = sec.startIndex; i <= sec.endIndex && i < paper.questions.length; i++) {
            aiTypedOeqQIds.add(paper.questions[i].id);
          }
        }
      }
    }

    // Re-score MCQ questions (in case answer keys changed)
    for (const q of paper.questions.filter(q2 => hasOpts(q2))) {
      const studentAns = (q.studentAnswer ?? "").trim().replace(/[().]/g, "").trim();
      const correctAns = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      // Support "X or Y" answers — student is correct if their answer matches any option
      const acceptableAnswers = correctAns.split(/\s+or\s+/).map(p => p.trim());
      const isCorrect = studentAns !== "" && acceptableAnswers.includes(studentAns);
      const marks = isCorrect ? (q.marksAvailable ?? 1) : 0;
      if (q.marksAwarded !== marks) {
        await prisma.examQuestion.update({
          where: { id: q.id },
          data: { marksAwarded: marks, markingNotes: isCorrect ? "Correct" : `Student: (${studentAns}), Correct: (${correctAns})` },
        });
        q.marksAwarded = marks;
      }
    }

    // Score typed section questions (always re-score on re-mark, in case answer keys changed)
    const ai = getAI();
    // Strip surrounding quotes the extractor sometimes bakes into the answer key
    // (e.g. "expressing" → expressing) before comparing.
    const stripQuotes = (s: string) => s.replace(/^["'`\s]+|["'`\s]+$/g, "");
    // Typed section marking: Grammar Cloze, Editing, Comp Cloze, Visual Text.
    // Exclude Visual Text MCQ (numeric answers 1-4) — those are scored as MCQ.
    // Don't use isMcqAnswer which also matches single letters ("a" is a valid editing word).
    for (const q of paper.questions.filter(qq => {
      if (!typedSectionQIds.has(qq.id)) return false;
      const topic = (qq.syllabusTopic ?? "").toLowerCase();
      if (topic.includes("visual") && topic.includes("text")) return false;
      return true;
    })) {
      const qTopicLower = (q.syllabusTopic ?? "").toLowerCase();
      const isGrammarClozeQ = qTopicLower.includes("grammar") && qTopicLower.includes("cloze");
      const studentAnsRaw = stripQuotes((q.studentAnswer ?? "").trim());
      const rawCorrect = stripQuotes(q.answer ?? "");
      let isCorrect = false;
      let acceptableAnswers: string[] = [];
      if (isGrammarClozeQ) {
        // Grammar cloze answer keys can be:
        // 1. Single letters from a word bank ("H", "K or P", "L/P") — match any case
        // 2. Actual words ("helps", "repairs") — match raw text case-insensitively
        const letterMatches = rawCorrect.match(/\b[A-Za-z]\b/g) ?? [];
        const isLetterKey = letterMatches.length > 0 && letterMatches.every(l => l.length === 1)
          && rawCorrect.replace(/[A-Za-z\s/,|.()or]+/gi, "").trim() === "";
        if (isLetterKey) {
          const letters = new Set(letterMatches.map(l => l.toUpperCase()));
          const studentLetter = (studentAnsRaw.toUpperCase().match(/\b[A-Z]\b/) ?? [""])[0];
          isCorrect = !!studentLetter && letters.has(studentLetter);
          acceptableAnswers = [...letters];
        } else {
          // Word-based grammar cloze — compare raw text case-insensitively
          acceptableAnswers = rawCorrect.split(/\s+or\s+|\//).map(a => stripQuotes(a.trim()));
          isCorrect = studentAnsRaw !== "" && acceptableAnswers.some(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
        }
      } else {
        // Editing section — compare raw text case-insensitively first
        acceptableAnswers = rawCorrect.split("/").map(a => stripQuotes(a.trim()));
        isCorrect = studentAnsRaw !== "" && acceptableAnswers.some(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
        // Capitalization check: if the matching answer-key alternative starts with a
        // capital letter (blank is at start of sentence), require student to capitalize first letter.
        if (isCorrect) {
          const matchingAlt = acceptableAnswers.find(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
          if (matchingAlt && /^[A-Z]/.test(matchingAlt)) {
            const studentFirst = studentAnsRaw.match(/[A-Za-z]/)?.[0] ?? "";
            if (studentFirst && studentFirst !== studentFirst.toUpperCase()) {
              isCorrect = false;
            }
          }
        }
      }

      // For Comp Cloze: if simple compare fails, use AI to check if student's word is valid.
      // Pass the RAW student answer (original case preserved) so the AI can flag a
      // missing capital letter at the start of a sentence. Same for the answer key.
      const qTopic = (q.syllabusTopic ?? "").toLowerCase();
      const isCompClozeQ = qTopic.includes("comprehension") && qTopic.includes("cloze");
      if (isCompClozeQ) {
        console.log(`[quiz-marking] Comp Cloze Q${q.questionNum}: student="${studentAnsRaw}" key="${rawCorrect}" simpleMatch=${isCorrect}`);
      }
      if (!isCorrect && studentAnsRaw && isCompClozeQ) {
        console.log(`[quiz-marking] Comp Cloze Q${q.questionNum}: calling AI fallback`);
        try {
          // Get passage context for the AI
          let passageCtx = "";
          if (meta?.englishSections) {
            const qIdx = parseInt(q.questionNum) - 1;
            const sec = meta.englishSections.find(s => qIdx >= s.startIndex && qIdx <= s.endIndex);
            if (sec?.passage) passageCtx = sec.passage;
          }
          const studentRaw = (q.studentAnswer ?? "").trim();
          const correctRaw = (q.answer ?? "").trim();
          const aiResp = await withTimeout(
            ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: [{ role: "user", parts: [{ text: `You are marking a Primary-school Comprehension Cloze blank.

A student filled in blank (${q.questionNum}) with "${studentRaw}".
The answer key (accepted alternatives, slash-separated) is: "${correctRaw}".
${passageCtx ? `\nPassage:\n${passageCtx}\n` : ""}
Decide whether the student's word fits the blank grammatically AND in meaning. Be STRICT about meaning — this is the default failure mode.

Procedure (follow in order):
1. Identify what the passage AS A WHOLE is about by reading the sentence before, the sentence containing the blank, and the sentence after the blank.
2. Identify what CONCEPT or OUTCOME the author is describing at this point (e.g. "the species surviving", "the weather getting worse", "the character becoming nervous").
3. Ask: does the student's word express that same concept/outcome? If it expresses a DIFFERENT concept — even a plausible or grammatically fine one — REJECT.
4. Ask: does the next sentence make sense as a continuation of what the student's word says? If the next sentence elaborates on an outcome that doesn't follow from the student's word, REJECT.

Concrete example of what to REJECT:
- Passage: "Whether a species ___ depends on the type of species. Some species are able to adapt quickly to changes in their environment, while others cannot."
- Answer key: "survives"
- Student word: "falls" — REJECT. "Falls" is grammatically fine and idiomatically possible, but the follow-up sentence is about adaptation leading to survival/extinction, not about falling. The student's word changes the topic away from survival.

Other rules:
- Accept any synonym that preserves BOTH the sentence meaning AND the cross-sentence flow (e.g. "survives" vs "lives on" in the example above is fine).
- Check grammatical fit: tense, number, word class.
- Check CAPITALIZATION: if the blank is at the start of a sentence (after a full stop, or first word of a paragraph), the student's word must begin with a capital letter. Otherwise reject.
- Spelling matters — misspelled words are NOT accepted.

Return ONLY JSON: {"accepted": true|false, "reason": "<one sentence citing grammar/meaning/flow/capitalization>"}` }] }],
              config: { responseMimeType: "application/json", temperature: 0.1 },
            }),
            15000,
            `comp-cloze-check-Q${q.questionNum}`
          );
          const parsed = extractJson(aiResp.text ?? "") as { accepted?: boolean; reason?: string };
          if (parsed.accepted) {
            console.log(`[quiz-marking] Comp Cloze Q${q.questionNum}: AI accepted "${studentRaw}" (key: "${correctRaw}") — ${parsed.reason}`);
            await prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: q.marksAvailable ?? 1, markingNotes: `Accepted: "${studentRaw}" — ${parsed.reason ?? ""}` },
            });
            q.marksAwarded = q.marksAvailable ?? 1;
            continue;
          }
          console.log(`[quiz-marking] Comp Cloze Q${q.questionNum}: AI rejected "${studentRaw}" — ${parsed.reason}`);
          await prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: 0, markingNotes: parsed.reason ?? `"${studentRaw}" does not fit the blank. Correct answer: "${correctRaw}"` },
          });
          q.marksAwarded = 0;
          continue;
        } catch (err) {
          console.warn(`[quiz-marking] Comp Cloze AI check failed for Q${q.questionNum}:`, err);
        }
      }

      await prisma.examQuestion.update({
        where: { id: q.id },
        data: {
          marksAwarded: isCorrect ? (q.marksAvailable ?? 1) : 0,
          markingNotes: studentAnsRaw ? (isCorrect ? "Correct" : `"${studentAnsRaw}" is incorrect. Correct answer: "${rawCorrect}"`) : "No answer",
        },
      });
      q.marksAwarded = isCorrect ? (q.marksAvailable ?? 1) : 0;
      console.log(`[quiz-marking] Typed Q${q.questionNum}: "${studentAnsRaw}" vs "${rawCorrect}" → ${isCorrect ? "correct" : "wrong"}`);
    }

    let totalAwarded = mcqQuestions.reduce((sum, q) => sum + (q.marksAwarded ?? 0), 0);
    const updates: ReturnType<typeof prisma.examQuestion.update>[] = [];

    if (oeqQuestions.length > 0) {
      const subDir = path.join(SUBMISSIONS_DIR, paperId);
      const ai = getAI();

      for (let i = 0; i < oeqQuestions.length; i++) {
        const q = oeqQuestions[i];
        const marksAvailable = q.marksAvailable ?? 1;

        // Build the expected-answer text. If subparts carry per-part answers
        // (from the merge/sync rebuild), format as a clear per-part breakdown
        // so the AI marks each part against its own answer key.
        type Subpart = { label: string; text: string; answer?: string | null };
        const subsForAns = (q.transcribedSubparts as Subpart[] | null) ?? null;
        const realSubsForAns = (subsForAns ?? []).filter(s => !s.label.startsWith("_"));
        const hasPerPartAnswers = realSubsForAns.some(sp => sp.answer);
        const expectedAnswer = hasPerPartAnswers
          ? realSubsForAns
              .map(sp => `Part (${sp.label}): ${sp.answer ?? "(no answer key — rely on the expected answer image if provided, else award 0)"}`)
              .join("\n")
          : (q.answer || "?");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: any[] = [];

        // Use transcribed stem + subparts as the question text
        if (q.transcribedStem) {
          let questionText = `Question: ${q.transcribedStem}`;
          // Include subpart details so AI marks each part separately
          const subparts = q.transcribedSubparts as { label: string; text: string }[] | null;
          if (subparts && subparts.length > 0) {
            const subpartTexts = subparts
              .filter(sp => !sp.label.startsWith("_"))
              .map(sp => `(${sp.label}) ${sp.text}`);
            questionText += "\n" + subpartTexts.join("\n");
          }
          parts.push({ text: questionText });
        }

        // Add question image if available
        if (q.imageData && q.imageData.startsWith("data:image")) {
          const match = q.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) {
            parts.push({ text: "Question image:" });
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }

        // Check if this is a typed answer (synthesis, comp OEQ in English quiz).
        // Only trust studentAnswer as typed text when the question is actually in a
        // synthesis/comprehension-OEQ section. For all other OEQs, studentAnswer may
        // be a stale marker like "No answer detected" from a previous marking run —
        // ignore it and re-read the canvas image.
        if (aiTypedOeqQIds.has(q.id) && q.studentAnswer && !q.studentAnswer.startsWith("data:")) {
          const qTopic = (q.syllabusTopic ?? "").toLowerCase();
          const isSynthesisQ = qTopic.includes("synthesis");

          // Extract text from JSON answers (OEQ with ticks stores as {"_text":"...","tick0":"true"})
          let fullStudentAnswer = q.studentAnswer;
          let tickInfo = "";
          if (fullStudentAnswer.startsWith("{")) {
            try {
              const parsed = JSON.parse(fullStudentAnswer) as Record<string, string>;
              const textVal = parsed._text ?? "";
              const ticks = Object.entries(parsed).filter(([k, v]) => k.startsWith("tick") && v === "true").map(([k]) => parseInt(k.replace("tick", "")));
              const tableCells = Object.entries(parsed).filter(([k, v]) => v && k.startsWith("r")).map(([k, v]) => `${k}: "${v}"`);
              fullStudentAnswer = textVal || (tableCells.length > 0 ? `[TABLE] ${tableCells.join(", ")}` : fullStudentAnswer);
              if (ticks.length > 0) {
                // Map tick indices to the checkbox labels from the stem
                const stemLines = (q.transcribedStem ?? "").split("\n");
                const checkboxLabels: string[] = [];
                for (const line of stemLines) {
                  const m = line.trim().match(/^\[[ x✓✗]\]\s*(.*)/i);
                  if (m) checkboxLabels.push(m[1].trim());
                }
                const tickedLabels = ticks.map(i => checkboxLabels[i] ?? `option ${i + 1}`);
                tickInfo = `\nStudent ticked: ${tickedLabels.join(", ")}`;
              }
            } catch { /* use raw */ }
          }
          if (isSynthesisQ && q.transcribedStem) {
            const kwMatch = q.transcribedStem.match(/\*\*([^*]+)\*\*/);
            if (kwMatch) {
              const keyword = kwMatch[1].trim();
              const kwEsc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              // If answer has ||| (before/after keyword), combine
              if (q.studentAnswer.includes("|||")) {
                const [beforeRaw, afterRaw] = q.studentAnswer.split("|||");
                // Strip an accidentally-duplicated keyword from the end of `before`
                // and the start of `after`, so a student who re-typed the keyword in
                // one of the inputs doesn't end up with "... whom whom ..." in the
                // stitched sentence.
                const before = beforeRaw.trim().replace(new RegExp(`\\s*\\b${kwEsc}\\b\\s*$`, "i"), "").trim();
                const after = afterRaw.trim().replace(new RegExp(`^\\s*\\b${kwEsc}\\b\\s*`, "i"), "").trim();
                fullStudentAnswer = `${before} ${keyword} ${after}`.replace(/\s+/g, " ").trim();
              } else {
                // Starting-word synthesis: strip a duplicated keyword from the start
                const after = q.studentAnswer.trim().replace(new RegExp(`^\\s*\\b${kwEsc}\\b\\s*`, "i"), "").trim();
                fullStudentAnswer = `${keyword} ${after}`.replace(/\s+/g, " ").trim();
              }
            }
          }

          // Format table answers into readable text
          let displayAnswer = fullStudentAnswer;
          const isTableAnswer = fullStudentAnswer.startsWith("{");
          if (isTableAnswer) {
            try {
              const cells = JSON.parse(fullStudentAnswer) as Record<string, string>;
              const cellEntries = Object.entries(cells).filter(([, v]) => v).map(([k, v]) => `${k}: "${v}"`);
              displayAnswer = `[TABLE] ${cellEntries.join(", ")}`;
            } catch { /* use raw */ }
          }
          const lastChar = displayAnswer.trim().slice(-1);
          parts.push({ text: `Student's typed answer (the delimiters below are NOT part of the answer):\n---\n${displayAnswer}\n---\nLast character of answer: "${lastChar}"${tickInfo}${isTableAnswer ? "\n(This is a TABLE answer — do NOT penalise for punctuation.)" : ""}` });
          parts.push({
            text: `Expected answer: ${expectedAnswer}
Marks available: ${marksAvailable}

Mark this answer. Compare the student's typed answer against the expected answer.

SPELLING & GRAMMAR PENALTY: Deduct 0.5 marks ONLY for genuine spelling errors (misspelled words). Do NOT deduct for punctuation (periods, commas, apostrophes, capitalisation). Do NOT flag missing or extra periods — ignore all punctuation completely.

For Synthesis & Transformation: This tests SENTENCE FORMATION. Be FAIR but not loose:
- The student's rewrite must use the required keyword(s) in the correct grammatical form.
- Allow slight variations that are grammatically correct AND do not change the meaning of the expected answer (e.g. minor word-order differences, equivalent connectors, or synonyms that preserve meaning and register). Do NOT penalise these.
- Do NOT deduct for periods, commas, capitalisation, or any punctuation. Ignore punctuation entirely.
- Deduct 0.5 for each genuine grammar error (wrong tense, subject-verb agreement, wrong form of the keyword, etc.).
- Deduct 0.5 if the rewritten sentence changes the meaning of the original sentence.
- The starting/joining word is included in the expected answer; the student must use it.
- Award full marks if the sentence is grammatical, uses the keyword correctly, and conveys the same meaning as the expected answer — even if some wording differs.
For Comprehension OEQ: This tests READING COMPREHENSION. Be LENIENT on language, STRICT on content:
- Mark based on whether the answer shows understanding of the passage and addresses the question.
- The student's answer does NOT need to match the expected answer word-for-word. Accept any answer that conveys the same meaning or key idea.
- Do NOT penalise for missing articles (a, an, the), minor grammar differences, or rephrasing — as long as the meaning is correct.
- Do NOT penalise for capitalisation differences.
- Only deduct 0.5 for genuine spelling errors (misspelled words, not style differences).
- If the answer captures the key point but uses different words, award full marks.
- If the answer is in TABLE format, do NOT penalise for punctuation at all.

The minimum marks awarded is 0 (do not go negative).

Return JSON: {"questions": [{"questionId": "${q.id}", "marksAwarded": <number>, "marksAvailable": ${marksAvailable}, "feedback": "<brief feedback including any spelling/grammar errors found>"}]}`
          });

          try {
            const response = await withTimeout(
              ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `quiz-typed-Q${q.questionNum}`
            );
            const parsed = extractJson(response.text ?? "") as { questions: Array<{ marksAwarded: number; feedback?: string }> };
            const result = parsed.questions?.[0];
            const awarded = Math.min(result?.marksAwarded ?? 0, marksAvailable);
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: awarded, markingNotes: result?.feedback ?? `Typed answer marked: ${awarded}/${marksAvailable}` },
              })
            );
            totalAwarded += awarded;
            console.log(`[quiz-marking] Typed Q${q.questionNum}: "${q.studentAnswer}" → ${awarded}/${marksAvailable}`);
          } catch (err) {
            console.error(`[quiz-marking] Typed Q${q.questionNum} marking failed:`, err);
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: 0, markingNotes: "Marking failed" },
              })
            );
          }
          continue;
        }

        // Student's handwritten answer from submission files
        let hasSubmission = false;
        type SubpartRow = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };
        const subparts = q.transcribedSubparts as SubpartRow[] | null;
        const realSubs = subparts?.filter(sp => !sp.label.startsWith("_")) ?? [];
        const hasDrawable = subparts?.some(sp => sp.label === "_drawable") ?? false;
        // Per-subpart reference image (from _subref-X sentinels) lets that subpart be drawable.
        const subRefLabels = new Set(
          (subparts ?? [])
            .filter(sp => sp.label.startsWith("_subref-") && sp.diagramBase64)
            .map(sp => sp.label.slice(8).toLowerCase())
        );
        // A subpart is drawable if it has a background diagram/ref image, or the whole
        // question is _drawable, or its text describes a drawing task (shade/draw/arrow).
        const drawTaskRe = /\b(shade|draw|arrow|circle|tick|mark|colour|color)\b/i;
        const drawableSubLabels = new Set<string>(
          realSubs
            .filter(sp => !!sp.diagramBase64 || !!sp.refImageBase64 || subRefLabels.has(sp.label.toLowerCase()) || drawTaskRe.test(sp.text ?? ""))
            .map(sp => sp.label.toLowerCase())
        );

        // For drawable diagram OEQ: check the INK-ONLY layer (transparent bg with
        // only student strokes). The composite image contains the printed diagram
        // which the AI mistakes for handwriting, so we never use it for the ink check.
        if (hasDrawable && realSubs.length === 0) {
          let inkFound = false;
          try {
            const inkPath = path.join(subDir, `page_${i}_ink.png`);
            const inkBuffer = await fs.readFile(inkPath);
            // Check if ink PNG has any non-transparent pixels
            inkFound = hasOpaquePixels(inkBuffer);
            console.log(`[quiz-marking] Drawable Q${q.questionNum}: ink pixel check → ${inkFound ? "HAS INK" : "BLANK"}`);
          } catch {
            console.log(`[quiz-marking] Drawable Q${q.questionNum}: no ink PNG file found`);
            inkFound = false;
          }
          if (!inkFound) {
            console.log(`[quiz-marking] Drawable Q${q.questionNum}: no ink detected — awarding 0`);
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: 0, studentAnswer: "No answer detected", markingNotes: "No written answer found" },
              })
            );
            continue;
          }
          console.log(`[quiz-marking] Drawable Q${q.questionNum}: ink detected — proceeding to mark`);
        }

        // For regular OEQ (non-drawable, non-subpart): blue ink pre-check using composite first.
        if (!hasDrawable && realSubs.length === 0) {
          let inkFound = true;
          try {
            const pagePath = path.join(subDir, `page_${i}.jpg`);
            const pageBuffer = await fs.readFile(pagePath);
            inkFound = await hasBlueInk(pageBuffer.toString("base64"), `quiz-oeq-Q${q.questionNum}`, "image/jpeg");
          } catch {
            try {
              const inkPath = path.join(subDir, `page_${i}_ink.png`);
              const inkBuffer = await fs.readFile(inkPath);
              inkFound = await hasBlueInk(inkBuffer.toString("base64"), `quiz-oeq-Q${q.questionNum}`, "image/png");
            } catch {
              inkFound = false;
            }
          }
          if (!inkFound) {
            console.log(`[quiz-marking] OEQ Q${q.questionNum}: no ink detected — awarding 0`);
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: 0, studentAnswer: "No answer detected", markingNotes: "No written answer found" },
              })
            );
            continue;
          }
        }

        // Try individual subpart images first — with per-subpart ink check
        const blankSubparts = new Set<string>();
        if (realSubs.length > 0) {
          for (const sp of realSubs) {
            // Check ink PNG for blank canvases using pixel check
            let spHasInk = true;
            try {
              const spInkPath = path.join(subDir, `page_${i}_${sp.label}_ink.png`);
              const spInkBuffer = await fs.readFile(spInkPath);
              spHasInk = hasOpaquePixels(spInkBuffer);
              console.log(`[quiz-marking] Q${q.questionNum}(${sp.label}): ink pixel check → ${spHasInk ? "HAS INK" : "BLANK"} (${spInkBuffer.length} bytes)`);
            } catch {
              // No ink file — assume ink exists
              spHasInk = true;
            }
            if (!spHasInk) {
              blankSubparts.add(sp.label);
              parts.push({ text: `Student's handwritten answer for part (${sp.label}): [BLANK — no answer written]` });
              continue;
            }
            try {
              const spPath = path.join(subDir, `page_${i}_${sp.label}.jpg`);
              const spBuffer = await fs.readFile(spPath);
              const isSpDrawable = drawableSubLabels.has(sp.label.toLowerCase());
              const labelNote = isSpDrawable
                ? `Student's handwritten answer for part (${sp.label}) — THIS IS A DRAWING TASK (shading/arrows/marks on a diagram). Ink is confirmed present:`
                : `Student's handwritten answer for part (${sp.label}):`;
              parts.push({ text: labelNote });
              parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: spBuffer.toString("base64") } });
              hasSubmission = true;
            } catch {
              // Individual subpart file not found
            }
          }
        }
        // If ALL subparts are blank (no ink in any), skip AI marking entirely
        if (realSubs.length > 0 && blankSubparts.size === realSubs.length) {
          console.log(`[quiz-marking] Q${q.questionNum}: all ${realSubs.length} subparts blank — awarding 0`);
          const blankNotes = realSubs.map(sp => `(${sp.label}) No answer provided.`).join(" ");
          const blankStudent = realSubs.map(sp => `(${sp.label}) `).join("\n");
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, studentAnswer: blankStudent, markingNotes: blankNotes },
            })
          );
          continue;
        }
        // Fallback: try combined image
        if (!hasSubmission) {
          try {
            const pagePath = path.join(subDir, `page_${i}.jpg`);
            const pageBuffer = await fs.readFile(pagePath);
            parts.push({ text: "Student's handwritten answer:" });
            parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: pageBuffer.toString("base64") } });
            hasSubmission = true;
          } catch {
            // No submission image
          }
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

        if (!hasSubmission) {
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, markingNotes: "No answer submitted" },
            })
          );
          continue;
        }

        // ── PHASE 1: Detect what the student wrote (WITHOUT showing the answer key) ──
        // This eliminates confirmation bias — the AI reads the image blind.
        // Strip the "Student's handwritten answer for part (X):" IMAGE labels
        // so the AI isn't primed by a pre-attached part letter for each
        // image. But KEEP the "[BLANK — no answer written]" markers for
        // blank subparts — otherwise the AI only sees the answered parts'
        // images and hallucinates content for the blank ones (e.g. when
        // a, b, c were blank and only d was answered, Phase 1 was inventing
        // fake answers for a, b, c because it had no signal they were empty).
        const detectParts = parts.filter(p => {
          if (!("text" in p) || typeof p.text !== "string") return true;
          if (!/^Student's handwritten answer for part \(/.test(p.text)) return true;
          // keep the blank-part markers so the detector knows those are empty
          return p.text.includes("[BLANK");
        });
        const isDrawableOnly = hasDrawable && realSubs.length === 0;
        const hasDrawableSubpart = drawableSubLabels.size > 0;
        const isDrawableAny = isDrawableOnly || hasDrawableSubpart;
        const drawableSubLabelList = [...drawableSubLabels].map(l => `(${l})`).join(", ");
        const drawableClause = isDrawableAny ? `

DRAWABLE DIAGRAM — CRITICAL:
${isDrawableOnly ? "This question" : `Part(s) ${drawableSubLabelList}`} has a printed diagram and the student answers by ADDING marks to it (shading a region, drawing arrows, circling objects, filling boxes). The pixel check has already confirmed blue ink is present${hasDrawableSubpart ? " on every drawing part listed above" : ""}, so your job is to describe what was DRAWN in blue ink on top of the printed diagram.
- DO NOT return "blank" for any drawing part — ink is definitely present.
- Describe the ink markings spatially and in terms of what they do to the diagram:
  * Shading → which region/object was shaded (e.g. "shaded the square on the left")
  * Arrows → where they start and where they point (e.g. "arrow from light bulb W pointing towards the object")
  * Circles / ticks / crosses → which object they mark
  * Lines drawn between objects → which objects are connected
- If the student wrote any letters, numbers or words (e.g. "A", "yes", "4") in blue ink, include those too.
- Be concrete: name the objects the student's marks touch/refer to, using labels from the printed diagram when possible.
` : "";
        detectParts.push({ text: `Read the student's handwritten answer from the image above.
${drawableClause}
IMPORTANT — FINAL ANSWER: Look for the "Ans:" line at the bottom-right of the answer area. The value written on or near this line is the student's FINAL ANSWER. Report this as the primary answer.

CRITICAL — PRESERVE UNITS AND SYMBOLS: Copy the final answer EXACTLY as written, including every unit and symbol the student put next to the number. Do NOT strip ° / cm / m / kg / g / ml / $ / % / ² / ³ / fractions — if the student wrote "21°" report "21°", if they wrote "5 cm" report "5 cm". If the unit was printed next to the Ans: line by the paper (not written by the student), still include it in the reported final answer so marking can compare against the expected answer with units.

FORMAT: Put each line of working on a SEPARATE line. Do NOT merge numbers from different lines into one.
For example, if the student wrote:
  Angle x = 180° − 2 × 35°
  = 110°
  Ans: 110°
Report it as:
  Working: Angle x = 180° − 2 × 35° = 110°
  Final answer: 110°

If the student drew a diagram (e.g. bar model, number line, shapes, arrows), describe it briefly (e.g. "Drew a bar model: 3 units = 42, 1 unit = 14").

SMALL / SHORT ANSWERS: Single digits (e.g. "4", "7") or single letters (e.g. "A") may be small and easy to miss. Scan the ENTIRE answer area carefully — especially near "Ans:" lines and in the top-right corner of sub-part regions. A thin blue stroke that resembles a digit IS the student's answer. Do NOT default to "blank" if there is any blue ink mark present.

If the question has sub-parts (a), (b), (c), report each separately. If a part is blank, say "blank".
Report EXACTLY what the student wrote, including any unit symbols. Return ONLY the detected text, nothing else.` });

        let detectedAnswer = "";
        const isMath = (paper.subject ?? "").toLowerCase().includes("math");
        const skipTextDetection = isMath && isDrawableAny && !!q.answerImageData;
        if (skipTextDetection) {
          // Math drawing questions (e.g. draw a line of symmetry, shade n
          // squares) with an answer image are graded by direct pixel
          // comparison in Phase 2. A textual pre-description just adds noise
          // and was sometimes confidently wrong ("shaded 4 squares" when the
          // student actually shaded 3). Phase 2 already has both images.
          detectedAnswer = "(drawing — see images)";
          console.log(`[quiz-marking] Q${q.questionNum}: math drawable — skipping Phase-1 text detection.`);
        } else {
          try {
            const detectResponse = await withTimeout(
              ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts: detectParts }],
                config: { temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `quiz-detect-q${q.questionNum}`
            );
            detectedAnswer = detectResponse.text?.trim() ?? "";
            console.log(`[quiz-marking] Q${q.questionNum} detected: "${detectedAnswer.substring(0, 100)}"`);
          } catch (err) {
            console.error(`[quiz-marking] Q${q.questionNum} detection failed:`, err);
          }
        }

        // ── PHASE 2: Compare detected answer against the answer key ──
        // Per-part answer image usage: the answer image only applies to parts whose
        // answer-key text says "see answer image" / "refer to answer image" / similar.
        // Other parts must be marked from their text answer alone — the AI must NOT
        // fall back to the image for them.
        // Sentinel phrases in the answer key that mean "this part is graded
        // against the ANSWER IMAGE, not against literal text". Accept common
        // shortenings — "img" / "image" / "diagram" / "drawing" — in the
        // sub-part answer so a typo like "see answer img" isn't treated as
        // literal expected text.
        const imgRefRe = /\b(see|refer\s+to)\b[^.|]*\b(answer\s+)?(image|img|diagram|drawing)\b/i;
        const imagePartsList = hasPerPartAnswers
          ? realSubsForAns.filter(sp => sp.answer && imgRefRe.test(sp.answer)).map(sp => sp.label)
          : [];
        const textOnlyPartsList = hasPerPartAnswers
          ? realSubsForAns.filter(sp => sp.answer && !imgRefRe.test(sp.answer)).map(sp => sp.label)
          : [];
        const answerImageUsageNote = hasPerPartAnswers && q.answerImageData
          ? `\nANSWER IMAGE SCOPE: The expected answer image ONLY applies to part(s): ${imagePartsList.length > 0 ? imagePartsList.map(l => `(${l})`).join(", ") : "NONE — ignore the image entirely"}. For part(s) ${textOnlyPartsList.map(l => `(${l})`).join(", ") || "(none)"}, mark ONLY against the text in the expected answer — do NOT refer to the answer image for those parts.`
          : "";

        const drawableMarkRule = isDrawableAny ? `

DRAWABLE DIAGRAM — MARKING RULES (applies to ${isDrawableOnly ? "this question" : `part(s) ${drawableSubLabelList}`}):
The student's answer for the drawing part(s) is a DRAWING on top of a printed diagram (shading, arrows, circles, etc.), not typed or written text. Compare the student's drawing image (labelled "Student's actual drawing(s)" above) against the "Expected answer image" directly.

MANDATORY PROCEDURE — do each step in order. The notes field MUST begin with a one-line machine-parseable header in this exact format:
    Expected: <N>. Student: <M>. Extras: <X>. Missing: <Y>.
Where N = count in the expected answer image, M = count in the student's drawing, X = marks the student added that the expected image doesn't have, Y = marks the expected image has that the student didn't draw. All four numbers are required, even if zero. After the header, describe the positions in plain English.

1. **Expected-image audit.** Count every discrete mark in the expected answer image: shaded cells, arrows, ticks, circles, lines, whatever the task asks for. State the count and describe each mark's position (e.g. "5 shaded cells at rows 2, 4, 5, 7, 9 of the leftmost column").
2. **Student-image audit.** Do the same for the student's drawing image.
3. **Diff.** Any mark present in the student's image but NOT in the expected image is an EXTRA. Any mark present in the expected image but NOT in the student's drawing is MISSING.
4. **Verdict.** Award marks based strictly on the diff:
   - Extras = 0 AND Missing = 0 AND every position matches → FULL MARKS.
   - Any extras OR any missing on a 1-mark question → 0 marks.
   - For a 2-mark question: award roughly proportional partial credit (e.g. 4 of 5 correct positions → 1 mark).

Never award full marks with extras or missing > 0. The header line is the source of truth — a downstream check will clamp marks to 0 if the header shows extras or missing.

CRITICAL rules:
- An EXTRA mark the student drew but the expected image doesn't have IS an error. Drawing MORE than asked is wrong. Do not hand-wave past this.
- A MISSING mark the expected image has but the student didn't draw IS an error.
- The pixel ink check has already confirmed blue ink is present — NEVER award 0 with the reason "blank" for a drawing part.
- If a text expected answer accompanies the image (e.g. "shade the opaque material"), still apply the count-and-position check; the image is authoritative.
- NEVER award full marks by default. If you cannot see the relevant marks clearly, say so in notes and award based on what is visible.
- The notes field MUST contain the four steps above (audit, audit, diff, verdict). Example: "Expected: 5 shaded squares at (1,2),(1,4),(2,1),(2,3),(3,2). Student: 7 shaded squares — same 5 positions PLUS (1,5) and (3,4). Two extras → wrong count → 0 of 1 marks."
` : "";

        // isMath was already computed above when deciding whether to skip
        // Phase-1 text detection on drawable math questions. Answer-first
        // rule suppressed for drawable math — those questions have no
        // 'Ans:' line, and letting it in makes the marker award full marks
        // whenever any ink is present.
        const mathAnswerFirstRule = isMath && !isDrawableAny ? `

MATH MARKING — ANSWER-FIRST RULE (IMPORTANT):
For math questions, working is secondary to the final answer:
- If the student's final answer (the value on or near the "Ans:" / "Answer:" line, or the clearly-stated final value) matches the expected answer → award FULL MARKS immediately. Do NOT deduct for missing, incomplete, or unclear working. Working is not required when the answer is right.
- ONLY when the final answer is WRONG or absent: scan the working steps for partial credit. Award partial marks proportional to marksAvailable if some steps or methods are correct.
- If wrong with no correct working → ZERO.
- Equivalent-form answers are equivalent answers: 1/2 = 0.5 = 50%; 3 1/2 = 7/2 = 3.5; 25 cm = 0.25 m if units accepted. Accept all standard equivalences unless the question asks for a specific form.
- If the student wrote the correct number but forgot the unit (and the expected answer specifies a unit), award FULL MARKS minus at most a 0.5-mark unit deduction; do not award 0.

MATH MARKING — CONTEXT IMPLIED BY THE QUESTION (IMPORTANT):
The student answers WHAT THE QUESTION ASKS. Do NOT demand extra phrasing that just restates context the question has already established:
- "Name a pair of perpendicular lines" → "VW and XW" is a complete answer. Do not deduct for missing "are perpendicular" / "⊥" / "perpendicular to each other" — the question already specified the relationship.
- "Name a pair of parallel lines" → "AB and CD" is complete. Do not require "parallel" to be restated.
- "Which figure has rotational symmetry?" → "Figure P" is complete; do not require the student to also write "has rotational symmetry".
- "How many …?" → a bare number is complete; do not require a sentence.
- "What is …?" → the value or object is complete; do not require "The answer is …".
Only insist on the relationship word / qualifier when the question EXPLICITLY asks the student to "describe", "explain", "state why", or "justify".
` : "";

        const isScience = (paper.subject ?? "").toLowerCase().includes("science");
        const sciencePartialRule = isScience ? `

SCIENCE PARTIAL-CREDIT RULE (IMPORTANT):
Primary-school Science answers are concept-based, not word-for-word. Award partial marks whenever the student's answer contains some of the key scientific concepts or phrases from the expected answer, even if the wording differs or the answer is incomplete.
- If the student captures ONE of multiple required concepts → award proportional partial marks (e.g. 1 of 2).
- Synonymous or equivalent phrasings count as the correct concept (e.g. "stops light" ≈ "blocks light", "goes up" ≈ "increases").
- Award 0 only when the answer is blank, fully off-topic, or misses every key concept.
- In notes, list which concepts/phrases the student got right and which were missing.

SCIENCE KEY-TERM EMPHASIS IN NOTES (IMPORTANT):
In the notes field, wrap every key scientific term or phrase from the expected answer in **double asterisks** so the review UI renders them in bold. Emphasise especially the terms/phrases the student MISSED (the ones that cost them marks).
- Examples of key terms: **photosynthesis**, **chlorophyll**, **evaporation**, **blocks light**, **heat energy is transferred**, **potential energy**.
- If a required concept was missing, name it and bold it: "The student did not mention **chlorophyll** or **sunlight**, so 1 mark was not awarded."
- If the student got a key term right, you may also bold it when calling it out positively.
- Only bold actual key terms/phrases — do not bold ordinary connector words.
` : "";

        const markPrompt = `You are marking a primary school student's answer. Be concise. Use British English throughout.

Question: ${q.transcribedStem ?? "See image"}
Student's answer (detected from their handwriting): "${detectedAnswer}"
Expected answer: "${expectedAnswer}"
${answerImageNote}${answerImageUsageNote}
Marks available: ${marksAvailable}

╔══════════════════════════════════════════════════════════════════════╗
║  ABSOLUTE RULE — READ CAREFULLY                                       ║
║                                                                        ║
║  The "Expected answer" above is GROUND TRUTH, set by a human marker.  ║
║  It is 100% correct. The "Expected answer image" (if any) is also     ║
║  ground truth.                                                         ║
║                                                                        ║
║  You are FORBIDDEN from:                                              ║
║  - Solving the question yourself                                       ║
║  - Evaluating whether the expected answer is "right"                   ║
║  - Proposing any alternative answer                                    ║
║  - Saying "should be X" where X differs from the expected answer      ║
║  - Using your own knowledge of the subject to decide what's correct   ║
║                                                                        ║
║  You MUST:                                                             ║
║  - Treat the expected answer as the ONLY correct answer                ║
║  - Compare the student's answer against it                             ║
║  - Award marks based ONLY on how well the student's answer matches     ║
║                                                                        ║
║  Example: If expected answer says "W and X" and student writes         ║
║  "W and X", award FULL MARKS. Do NOT second-guess it by thinking      ║
║  the real answer might be "W and Z" — the human marker is correct.    ║
╚══════════════════════════════════════════════════════════════════════╝

CRITICAL — DEGREE SYMBOL: ONLY if the expected answer literally contains ° (e.g. "8°", "45°"), accept a trailing 0 as degree symbol.
CRITICAL — DIGIT "1": A handwritten "1" is often just a thin vertical stroke — do not dismiss it.
${drawableMarkRule}${mathAnswerFirstRule}${sciencePartialRule}
Instructions:
1. Compare the student's detected answer against the expected answer (including synonyms and equivalent phrasing). For Science, apply the SCIENCE PARTIAL-CREDIT RULE above — partial credit for partial concept coverage.
   - If correct → FULL MARKS.
   - Partially correct → PARTIAL marks for matching portions.
   - Wrong or blank → ZERO.
2. For multi-part (a), (b), (c): compare each part against its part of the expected answer.
3. In notes: describe whether the student's answer matches the expected answer, and for each part state "Awarded N mark(s)" explicitly so downstream code can parse per-part correctness. NEVER propose an alternative answer that contradicts the expected answer.

Return ONLY valid JSON:
{"questionId": "${q.id}", "marksAvailable": ${marksAvailable}, "marksAwarded": <number>, "studentAnswer": "${detectedAnswer.replace(/"/g, '\\"').replace(/\n/g, '\\n')}", "notes": "<feedback>"}`;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const markParts: any[] = [];

        // For drawable parts the Phase-1 detection turns a drawing into a text
        // description, which tends to drop lines/marks (it once called a full
        // quadrilateral "two lines"). Pass the actual student drawing image(s)
        // through to Phase 2 so the AI can compare pixels to the expected
        // answer image directly, not via a lossy textual hand-off.
        if (isDrawableAny) {
          for (const p of parts) {
            if ("inlineData" in p && p.inlineData?.data) markParts.push(p);
          }
          if (markParts.length > 0) {
            markParts.unshift({ text: "Student's actual drawing(s) (compare visually for drawing parts):" });
          }
        }

        // Include answer image if available for visual comparison
        if (q.answerImageData && q.answerImageData.startsWith("data:image")) {
          const match = q.answerImageData.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) {
            markParts.push({ text: "Expected answer image (ground truth):" });
            markParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
        markParts.push({ text: markPrompt });

        // Attempt marking with retries. Parse failures now feed back into the
        // loop instead of silently dead-ending at "Failed to parse AI
        // response" — the retry prepends a stricter JSON-only reminder so
        // the next attempt is much more likely to return parseable output.
        // Drawable questions with an answer image need stronger visual
        // reasoning than flash can reliably provide (flash was marking
        // "7 shaded blocks vs 5 expected" as correct). Math-drawable-
        // with-image questions run on 3.1-pro-preview — already in use
        // by the elaborate/solver routes, has the best visual reasoning
        // of the preview pro tier. Fall back to 2.5-pro then flash if
        // 3.1 is rate-limited. Non-math drawable stays on 2.5-pro.
        const needsPro = isDrawableAny && !!q.answerImageData;
        const QUIZ_MODELS = needsPro
          ? (isMath
            ? ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"]
            : ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash"])
          : ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
        const JSON_ONLY_REMINDER = "IMPORTANT: Your previous response could not be parsed. Return ONLY the JSON object requested. No prose, no explanation, no markdown fences — just the raw JSON starting with { and ending with }.";
        let lastErr: unknown = null;
        let lastParseFailText: string | null = null;
        for (let attempt = 0; attempt < QUIZ_MODELS.length; attempt++) {
          try {
            if (attempt > 0) {
              const delay = attempt * 5000;
              console.log(`[quiz-marking] OEQ Q${q.questionNum} waiting ${delay}ms before retry ${attempt + 1}...`);
              await new Promise(r => setTimeout(r, delay));
            }
            const model = QUIZ_MODELS[attempt];
            // On a retry triggered by a parse failure, add a stricter reminder.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const attemptParts: any[] = lastParseFailText
              ? [...markParts, { text: JSON_ONLY_REMINDER }]
              : markParts;
            const response = await withTimeout(
              ai.models.generateContent({
                model,
                contents: [{ role: "user", parts: attemptParts }],
                // Drawable comparison benefits from deterministic output.
                config: { temperature: needsPro ? 0 : 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `quiz-oeq-q${q.questionNum}`
            );

            const text = response.text?.trim() ?? "";
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as QuestionMarkResult;
              // Override studentAnswer with the phase-1 detection (unbiased)
              parsed.studentAnswer = detectedAnswer || parsed.studentAnswer;
              let awarded = Math.min(marksAvailable, Math.max(0, Number(parsed.marksAwarded) || 0));

              // Drawable-with-image tightening: the prompt requires the
              // notes field to surface the count diff. If the notes
              // explicitly say extras > 0 or missing > 0, the student's
              // drawing does NOT match the expected image — clamp the
              // awarded mark down. This catches the "waved-through"
              // case where Gemini described the difference correctly
              // but still awarded full marks anyway.
              if (needsPro && parsed.notes && awarded > 0) {
                const notes = String(parsed.notes);
                const extrasMatch = notes.match(/\bextras?\s*[:=]\s*(\d+)/i);
                const missingMatch = notes.match(/\bmissing\s*[:=]\s*(\d+)/i);
                const extras = extrasMatch ? parseInt(extrasMatch[1], 10) : 0;
                const missing = missingMatch ? parseInt(missingMatch[1], 10) : 0;
                if (extras > 0 || missing > 0) {
                  // For a 1-mark question any mismatch is a zero.
                  // For multi-mark: reduce proportional to total count.
                  const expectedMatch = notes.match(/\bexpected\s*(?:count)?\s*[:=]\s*(\d+)/i);
                  const expectedCount = expectedMatch ? Math.max(1, parseInt(expectedMatch[1], 10)) : 1;
                  const wrong = extras + missing;
                  if (marksAvailable <= 1 || wrong >= expectedCount) {
                    awarded = 0;
                  } else {
                    const ratio = Math.max(0, 1 - wrong / expectedCount);
                    awarded = Math.round(marksAvailable * ratio * 2) / 2; // round to 0.5
                  }
                  console.log(`[quiz-marking] Q${q.questionNum} drawable clamp: extras=${extras} missing=${missing} expected=${expectedCount} → ${awarded}/${marksAvailable}`);
                }
              }

              totalAwarded += awarded;
              updates.push(
                prisma.examQuestion.update({
                  where: { id: q.id },
                  data: {
                    marksAwarded: awarded,
                    studentAnswer: parsed.studentAnswer || null,
                    markingNotes: buildMarkingNotes({ ...parsed, questionId: q.id, marksAvailable, marksAwarded: awarded }),
                  },
                })
              );
              lastErr = null;
              lastParseFailText = null;
              break;
            }
            // No JSON found — record and retry the loop rather than dead-ending.
            lastParseFailText = text;
            console.warn(`[quiz-marking] OEQ Q${q.questionNum} attempt ${attempt + 1} returned no JSON (${text.length} chars); will retry`);
            continue;
          } catch (err) {
            lastErr = err;
            console.warn(`[quiz-marking] OEQ Q${q.questionNum} attempt ${attempt + 1} (${QUIZ_MODELS[attempt]}) failed:`, err);
          }
        }
        if (lastErr) {
          console.error(`[quiz-marking] OEQ Q${q.questionNum} failed after ${QUIZ_MODELS.length} attempts:`, lastErr);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, markingNotes: "Marking error — AI unavailable, please re-mark" },
            })
          );
        } else if (lastParseFailText !== null) {
          console.error(`[quiz-marking] OEQ Q${q.questionNum} all ${QUIZ_MODELS.length} attempts returned non-JSON; last response (truncated): ${lastParseFailText.slice(0, 200)}`);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, markingNotes: "Failed to parse AI response after retries — please re-mark" },
            })
          );
        }
      }
    }

    // Batch update OEQ marks + set paper score/status
    await prisma.$transaction([
      ...updates,
      prisma.examPaper.update({
        where: { id: paperId },
        data: { score: totalAwarded, markingStatus: "complete" },
      }),
    ]);

    // Generate feedback
    await generateFeedbackSummary(paperId);

    // Auto-release if 100% score and student has skipReviewPerfect enabled
    const totalAvailable = paper.questions.reduce((sum, q) => sum + (q.marksAvailable ?? 0), 0);
    if (totalAvailable > 0 && totalAwarded >= totalAvailable && paper.assignedToId) {
      const student = await prisma.user.findUnique({ where: { id: paper.assignedToId }, select: { settings: true } });
      const settings = (student?.settings ?? {}) as Record<string, unknown>;
      if (settings.skipReviewPerfect === true) {
        await prisma.examPaper.update({ where: { id: paperId }, data: { markingStatus: "released" } });
        console.log(`[quiz-marking] Paper ${paperId} auto-released (100% score, skipReviewPerfect=true)`);
      }
    }

    console.log(`[quiz-marking] Paper ${paperId} done. Score: ${totalAwarded}`);
  } catch (err) {
    console.error(`[quiz-marking] Failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
  }
}
