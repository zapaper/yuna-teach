import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { isOpenAIFallbackEnabled, isTransientServerError, runOpenAIFallback } from "@/lib/openai-fallback";
import { generateContentWithRetry } from "@/lib/gemini";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isCompOeqLabel } from "@/lib/english-sections";

// Re-run a marker on transient failure (Gemini timeout / 504 /
// rate limit / network blip). Each marker has its own try/catch
// that writes markingStatus="failed" and exits — this wrapper
// polls that status after each attempt and re-runs if needed,
// without touching the marker body. Each retry: the marker sets
// "in_progress" at its start (overwrites the previous "failed")
// and re-fetches the paper, so there's no half-saved state to
// reconcile.
const MAX_MARK_ATTEMPTS = 3;
const MARK_RETRY_DELAYS_MS = [30_000, 60_000]; // before attempt 2, then before attempt 3
async function withMarkRetry(label: string, paperId: string, fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_MARK_ATTEMPTS; attempt++) {
    await fn();
    const after = await prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { markingStatus: true },
    });
    if (after?.markingStatus !== "failed") return; // success or in-progress (other writer)
    if (attempt >= MAX_MARK_ATTEMPTS) {
      console.error(`[${label}] ${paperId} still failed after ${attempt} attempts — giving up`);
      return;
    }
    const delay = MARK_RETRY_DELAYS_MS[attempt - 1] ?? 60_000;
    console.warn(`[${label}] ${paperId} attempt ${attempt}/${MAX_MARK_ATTEMPTS} failed, retrying in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

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

/**
 * Flatten a transparent ink PNG onto a solid white background.
 *
 * Tried PNG output (lossless) but Gemini empirically struggled to detect
 * strokes in our PNG format — possibly a colour-profile / bit-depth quirk
 * with sharp's PNG encoder. JPG at quality 95 works reliably for the
 * Q11 test case (72.5°). Keeping JPG.
 *
 * Used for quiz OEQ canvases where the app saves both:
 *   - page_X_ink.png (transparent, strokes only) — used by hasOpaquePixels
 *   - page_X.jpg     (supposedly strokes flattened on white)
 * Observed bug: the upstream JPG sometimes renders as blank/empty even
 * though the ink PNG clearly has strokes. Doing the flatten ourselves
 * bypasses that pipeline.
 */
async function flattenInkOnWhite(pngBuffer: Buffer, _label: string): Promise<{ buffer: Buffer; mimeType: "image/jpeg" }> {
  // Per-subpart INK_FLATTEN log dropped — was firing once per subpart per
  // re-mark and adding nothing the ink-pixel-check log doesn't already
  // tell you.
  const buffer = await sharp(pngBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return { buffer, mimeType: "image/jpeg" };
}

/**
 * Crop a scanned-page JPEG buffer to a question's writing-area
 * region using printableBounds. Bounds carry pageIndex +
 * yStartPct + yEndPct (top-down percentages). If the question
 * has subpart bounds, returns a record { [label]: buffer } —
 * each subpart cropped to its own slice. Otherwise returns the
 * cropped page as a single buffer.
 *
 * Falls back to the original buffer when bounds are missing,
 * malformed, or we're looking at a different page than the one
 * the bounds describe. The marker pipeline can then proceed with
 * the whole page (legacy behaviour) without changing call shape.
 */
type Bounds = { pageIndex: number; yStartPct: number; yEndPct: number };
type PrintableBounds = Bounds & { subparts?: Record<string, Bounds> };

async function cropPageByBounds(
  pageBuffer: Buffer,
  bounds: PrintableBounds | null | undefined,
  submissionPage: number,
): Promise<Buffer> {
  if (!bounds) return pageBuffer;
  if (bounds.pageIndex !== submissionPage) return pageBuffer;
  if (!Number.isFinite(bounds.yStartPct) || !Number.isFinite(bounds.yEndPct)) return pageBuffer;
  if (bounds.yEndPct <= bounds.yStartPct) return pageBuffer;
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(pageBuffer).metadata();
    if (!meta.height || !meta.width) return pageBuffer;
    const top = Math.max(0, Math.floor(meta.height * (bounds.yStartPct / 100)));
    const bottom = Math.min(meta.height, Math.ceil(meta.height * (bounds.yEndPct / 100)));
    const height = Math.max(1, bottom - top);
    return await sharp(pageBuffer)
      .extract({ left: 0, top, width: meta.width, height })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch (err) {
    console.warn(`[crop] failed for page ${submissionPage}:`, err);
    return pageBuffer;
  }
}

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

function getAI(): GoogleGenAI {
  // Marking originally called ai.models.generateContent directly, which
  // meant a single 429 from the primary Gemini key killed the entire
  // marking pass — no backup-key, no OpenAI fallback, no model-family
  // hop. Route every marking call through generateContentWithRetry
  // (maxRetries=0 — the marking loop above already does its own 3-
  // attempt model-escalation; we just want the shared fallback chain).
  //
  // This also makes the OPENAI_AS_PRIMARY=1 flag work for marking
  // automatically, since the wrapper already honours it.
  const proxy = {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContent: (params: any) => generateContentWithRetry(params, 0, 0, "marking"),
    },
  };
  // Keep the unused-import escape hatches so future refactors don't
  // strip them while this proxy is the only thing tying the file
  // together with the OpenAI helpers.
  void isOpenAIFallbackEnabled;
  void runOpenAIFallback;
  void GoogleGenAI;
  return proxy as unknown as GoogleGenAI;
}

/** Crop a page image to a vertical region defined by yStartPct/yEndPct */
async function cropPageRegion(
  pageBuffer: Buffer,
  yStartPct: number,
  yEndPct: number,
  label: string = "",
  // X-bounds are optional. Sections that have multiple blanks on the
  // same line — Editing, Grammar Cloze, Comp Cloze — store per-question
  // xStartPct/xEndPct during Normal Extract so the marker can crop to
  // the exact word/blank instead of grabbing the whole line. Without
  // these, two blanks on the same line get IDENTICAL crops and the AI
  // has to guess which question's answer it's checking, producing
  // false detections (the "into / placed" pair on PSLE English).
  xStartPct: number | null = null,
  xEndPct: number | null = null,
  // Subject controls how much bottom slack the crop gets — Math /
  // Science OEQ trail "Ans:" lines below the printed box and need a
  // generous bottom pad, English / Chinese cloze and editing are
  // tightly packed line-by-line and a generous pad pulls neighbours
  // into the crop. See padBottom calc below for the actual tiers.
  // Default unset = math/sci (preserves pre-existing behaviour for
  // every call site that hasn't been updated yet).
  subject: string | null = null,
): Promise<Buffer> {
  const meta = await sharp(pageBuffer).metadata();
  const height = meta.height ?? 1;
  const width = meta.width ?? 1;
  // Padding tiers:
  //   - Math / Science OEQ (NO x-bounds): 1% top, 6% bottom. Student's
  //     final answer / "Ans:" line typically sits below the printed
  //     answer box and needs generous bottom slack — commit 46bc05e5
  //     (Apr 2026) bumped 2%→6% to stop clipping "Ans:" lines.
  //   - Cloze / Editing / Synthesis (HAS x-bounds): 1% top, 1.5%
  //     bottom. Blanks here are packed tightly (4–5% per question
  //     in PSLE Comp Cloze) — a 6% bottom pad pulls TWO neighbours
  //     into the crop and the AI grabs the wrong blank's word.
  //     Real failure: PSLE English 2025 Q46 (expected "doubt") was
  //     detected as "traced" because the crop extended down into
  //     Q48's blank (Q48's expected is "traced"). Same shift pattern
  //     on Q49→Q50, Q58→Q59, Q31→Q32 in Grammar Cloze. Presence of
  //     xStartPct/xEndPct is the unambiguous "I'm a tight-packed
  //     blank" signal — Math/Science OEQ never has x-bounds.
  //   - Subject explicitly overrides: English / Chinese papers go on
  //     a tighter ladder even WITHOUT x-bounds, because Comp OEQ /
  //     Comp Cloze passages are still much more vertically packed
  //     than a Math/Science working box.
  const hasXBounds = xStartPct != null && xEndPct != null && Number.isFinite(xStartPct) && Number.isFinite(xEndPct) && xEndPct > xStartPct;
  const subjLc = (subject ?? "").toLowerCase();
  const isEnglishOrChinese = subjLc.includes("english") || subjLc.includes("chinese");
  const padTop = height * 0.01;
  const padBottom = height * (
    hasXBounds ? 0.015 :              // per-blank crop — cloze / editing / synthesis
    isEnglishOrChinese ? 0.03 :       // English / Chinese OEQ (no x) — medium
    0.06                              // Math / Science OEQ — generous "Ans:" slack
  );
  const top = Math.max(0, Math.round((yStartPct / 100) * height - padTop));
  const bottom = Math.min(height, Math.round((yEndPct / 100) * height + padBottom));
  const cropHeight = Math.max(1, bottom - top);

  // X-bounds: use when both are valid percentages with end > start.
  // Add a small horizontal pad so a word touching the box edge isn't
  // shaved off, but stay tight enough to give the AI single-blank
  // context.
  let left = 0;
  let cropWidth = width;
  if (xStartPct != null && xEndPct != null && Number.isFinite(xStartPct) && Number.isFinite(xEndPct) && xEndPct > xStartPct) {
    const padX = width * 0.01;
    left = Math.max(0, Math.round((xStartPct / 100) * width - padX));
    const right = Math.min(width, Math.round((xEndPct / 100) * width + padX));
    cropWidth = Math.max(1, right - left);
  }

  const cropped = await sharp(pageBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg()
    .toBuffer();
  const xTag = (xStartPct != null && xEndPct != null) ? ` xStart=${xStartPct}% xEnd=${xEndPct}%` : "";
  console.log(`[marking] CROP ${label}: original ${width}x${height}, yStart=${yStartPct}% yEnd=${yEndPct}%${xTag} padTop=${(padTop/height*100).toFixed(1)}% padBottom=${(padBottom/height*100).toFixed(1)}% → left=${left}px top=${top}px cropW=${cropWidth}px cropH=${cropHeight}px, size=${cropped.length}b`);
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
    // Caller logs the outcome ("no ink detected — awarding 0" or proceeds
    // with marking). Only log here when the model returned something
    // unexpected so debugging signal isn't lost in normal flow.
    if (text !== "YES" && text !== "NO") {
      console.log(`[marking] BLUE INK CHECK ${label}: unexpected response "${text.slice(0, 40)}" → treating as ${result ? "HAS INK" : "BLANK"}`);
    }
    return result;
  } catch (err) {
    // If pre-check fails, assume ink exists to avoid false negatives
    console.warn(`[marking] BLUE INK CHECK ${label} failed, assuming ink exists:`, err);
    return true;
  }
}

/** Detect MCQ answer(s) from a page image WITHOUT revealing expected answers (avoids confirmation bias).
 *  Returns map of questionId → detected digit/letter or null. */
export async function detectMcqAnswers(
  imageBase64: string,
  questions: Array<{ id: string; questionNum: string; yStartPct: number | null; yEndPct: number | null }>,
  label: string,
  temperature = 0.4,
  hintAnswer1QuestionIds: Set<string> = new Set(),
  // True for Chinese cloze sections (短文填空 / 完成对话) where the
  // student CIRCLES one of the printed option labels (1)/(2)/(3)/(4)
  // inline with the question, instead of writing a digit in a right-
  // margin "Answer:" box. The default prompt looks at the rightmost
  // 10% only and ignores anything in the centre — fine for English
  // Test Quiz scanned back, useless for Chinese cloze. The flag swaps
  // to a "find which printed option label has a hand-drawn loop /
  // ring / underline / cross over it" instruction.
  isCircledChinese = false,
): Promise<Map<string, string | null>> {
  const qLines = questions.map((q) => {
    const yStart = q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
    const yEnd = q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
    const hint = hintAnswer1QuestionIds.has(q.id)
      ? ` ⚠️ HINT: The answer for this question is likely the digit "1" — a single short vertical blue stroke (like | or l or I). It may be very thin and small. Look carefully for ANY vertical blue line in the answer area.`
      : "";
    return `- Question ${q.questionNum} (ID: ${q.id}): answer region ${yStart}–${yEnd} from top of image${hint}`;
  }).join("\n");

  const prompt = isCircledChinese ? `你正在阅读学生在新加坡 PSLE 华文试卷的「短文填空」/「完成对话」部分所做的选择题答案。

颜色区分 — 至关重要:
- 试卷上的印刷文字是 黑色 或 深灰色: 题目、印刷的选项标号 "(1)" / "(2)" / "(3)" / "(4)" / "(5)" 等、问号、所有印好的字。一律忽略所有黑色印刷文字。
- 学生用 蓝色墨水 在印刷的选项标号上画圈 / 圆圈 / 椭圆 / 划线 / 打勾来选择答案。仅识别明显的蓝色手写痕迹。

在每题指定的纵向范围内 (yStart% 到 yEnd%) 寻找:
- 哪一个印刷的选项标号被学生用蓝色墨水「圈」起来或标记?
- 选项标号通常是 "(1)" "(2)" "(3)" "(4)" 这种形式 (短文填空有 4 个; 完成对话可能有 1-8 个)。
- 学生的标记形式可能是: 在数字外画一个圆圈、椭圆、方框、底线、划掉非选答案、或者在选项旁打勾 (✓)。

判断规则:
1. 只识别明显的蓝色手写痕迹 (而非印刷的黑色文字)。
2. 如果某一个选项标号 (例如 "(2)") 周围有蓝色圆圈 / 椭圆 / 任何蓝色环绕标记 — 这就是答案。返回该数字 "2"。
3. 如果有蓝色划线在选项数字下面 — 这也是答案。
4. 如果完全看不见任何蓝色手写标记 — 报 null (学生没作答)。
5. 不要把印刷的 "(1)"、"(2)" 等本身当成答案。
6. 不要把题目中无关位置的蓝色涂改 / 旁注当作答案 — 只看印刷的选项标号附近。
7. 如果有多个选项都被圈了,选最明显的那一个;如果一样明显,返回 null。

题目列表:
${qLines}

只返回有效的 JSON (不要 markdown 代码围栏):
{
  "answers": [
    {"questionId": "ID", "detected": "2", "confidence": "high"},
    {"questionId": "ID", "detected": null, "confidence": "high"}
  ]
}` : `You are reading a student's handwritten MCQ answers from an exam paper.

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

  // Model selection.
  //   - First pass on the full page: gemini-2.5-flash (cheap, good
  //     enough when handwriting is clear).
  //   - MCQ retry pass (called with label that starts with "mcqRetry"):
  //     always bump to gemini-3.1-pro-preview. Retry only fires when
  //     the first pass returned null, so by definition this is a hard
  //     case — print+scan workflow, faint ink, scan glare. The pro
  //     model is worth the extra cost on this narrow subset, and
  //     handles non-"1" answers (which previously stayed on flash).
  //   - "1"-hint on the first pass: still bump to 2.5-pro (thin
  //     vertical stroke is easy to miss for flash).
  const isRetryPass = label.startsWith("mcqRetry") || label.startsWith("remarkSingle");
  // Second-opinion pass on a wrong MCQ — re-detect with a heavier
  // model to double-confirm the digit. Was gemini-3.1-flash-preview
  // but Google retired that endpoint (404 NOT_FOUND). Swap to 3.1-pro-
  // preview — same family the retry pass already uses, so we know it
  // works against this codebase. Verify only runs on the rare wrong-
  // MCQ subset (≤6 per paper based on observed logs) so the cost
  // bump is bounded.
  const isVerifyPass = label.startsWith("mcqVerify");
  const mcqModel = isVerifyPass
    ? "gemini-3.1-pro-preview"
    : isRetryPass
      ? "gemini-3.1-pro-preview"
      : hintAnswer1QuestionIds.size > 0 ? "gemini-2.5-pro" : "gemini-2.5-flash";

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
    const parsed = extractJson(text) as { answers?: unknown };
    const result = new Map<string, string | null>();
    // Defensive: the `as { answers: Array<...> }` cast is a compile-
    // time hint, not a runtime guarantee. Gemini occasionally returns
    // valid JSON without the expected shape — `{error: "..."}`,
    // `{result: "..."}`, or `{answers: "single-string"}` — and the
    // bare `for...of parsed.answers` then throws "r.answers is not
    // iterable". The try/catch below already turns it into a benign
    // empty Map, but the noisy stack trace ends up in production logs
    // every time. Detect-and-warn cleanly instead.
    if (!Array.isArray(parsed.answers)) {
      console.warn(`[marking] MCQ detect ${label}: response missing .answers array (got: ${JSON.stringify(parsed).slice(0, 120)})`);
      return result;
    }
    const answersArr = parsed.answers as Array<{ questionId: string; detected: string | null; confidence?: string }>;
    for (const a of answersArr) {
      // Discard low-confidence detections — treat as null (no answer)
      const val = a.confidence === "low" ? null : a.detected;
      result.set(a.questionId, val);
      console.log(`[marking] MCQ DETECT ${label} (${mcqModel}) Q-ID ${a.questionId}: detected="${a.detected}", confidence=${a.confidence ?? "?"}, using="${val}"`);
    }
    return result;
  } catch (err) {
    console.warn(`[marking] MCQ detect failed for ${label}:`, err);
    return new Map();
  }
}

/**
 * Detect a single MCQ answer from a TIGHTLY CROPPED image of the
 * printable "Answer: ___" line (already cropped to ~the right
 * half of the page, several pt above the underscore and a bit
 * below). Different prompt from detectMcqAnswers because:
 *   - the layout is fixed: the line is horizontal, label "Answer:"
 *     on the left, blank underscore on the right
 *   - there's no MCQ option text in the crop, so we don't have to
 *     warn the AI to ignore "(1)/(2)/(3)/(4)" labels
 *   - the answer is always touching the underscore line
 * Returns the detected digit/letter (uppercase, no parens) or null.
 */
async function detectPrintableMcqAnswer(
  imageBase64: string,
  q: { id: string; questionNum: string },
  label: string,
  retry = false,
): Promise<string | null> {
  // First pass uses the layout-aware prompt; retry uses a plain-OCR
  // prompt + the stronger gemini-3.1-pro-preview model. The
  // layout-aware prompt sometimes pushes the model toward null when
  // it's hedging about WHERE the ink is, even though the crop
  // clearly contains one of the eight target characters.
  const layoutPrompt = `You are looking at a tightly-cropped strip from a printed MCQ exam paper.

The crop shows the "Answer:" line for Question ${q.questionNum}. Layout:
- The word "Answer:" is printed in BLACK ink on the left.
- To the right of "Answer:" is a HORIZONTAL UNDERSCORE LINE — a thin grey line that's blank by default.
- The student HANDWROTE their MCQ answer in BLUE INK directly on or just above that underscore line.

Your job: report the single digit (1, 2, 3, or 4) or letter (A, B, C, or D) the student wrote.

RULES:
- ONLY blue handwriting on the underscore line counts. The printed "Answer:" label is black — IGNORE it.
- If the underscore is completely blank (no blue ink), return null.
- The answer is always exactly ONE of: 1, 2, 3, 4, A, B, C, D. Never multiple.
- "1" looks like a thin vertical stroke (similar to "l" or "I") — still report as "1".
- If the ink is faint or partial but still clearly forms a digit/letter, report it.

Return ONLY JSON (no markdown fences):
{"detected": "1" | "2" | "3" | "4" | "A" | "B" | "C" | "D" | null, "confidence": "high" | "medium" | "low"}`;

  const plainPrompt = `Look at this image. It contains exactly one handwritten character drawn in BLUE INK.

That character is exactly one of: 1, 2, 3, 4, A, B, C, D.

What is it? Ignore any printed black text. Only the blue handwriting counts.

Return ONLY JSON: {"detected": "1" | "2" | "3" | "4" | "A" | "B" | "C" | "D" | null, "confidence": "high" | "medium" | "low"}`;

  const prompt = retry ? plainPrompt : layoutPrompt;
  // Retry uses the strongest reasoning-tier model we have, since
  // by that point Flash already declined to commit on a crop that
  // (per the saved debug image) clearly contains one of the eight
  // target characters. One extra second of latency on a rare
  // retry path is a fair trade for catching it.
  const model = retry ? "gemini-3.1-pro-preview" : "gemini-2.5-flash";
  const temperature = retry ? 0.4 : 0.2;

  try {
    const response = await withTimeout(
      getAI().models.generateContent({
        model,
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: imageBase64 } },
          { text: prompt },
        ]}],
        config: { responseMimeType: "application/json", temperature },
      }),
      GEMINI_TIMEOUT_MS,
      `printable MCQ detect ${label}`,
    );
    const text = response.text;
    if (!text) return null;
    const parsed = extractJson(text) as { detected: string | null; confidence?: string };
    const val = parsed.detected;
    console.log(`[marking] PRINTABLE MCQ DETECT ${label} (${model}): detected="${parsed.detected}", confidence=${parsed.confidence ?? "?"}, using="${val}"`);
    return val ?? null;
  } catch (err) {
    console.warn(`[marking] printable MCQ detect failed for ${label}:`, err);
    return null;
  }
}

/** Check if a question is MCQ based on its expected answer */
function isMcqAnswer(answer: string | null): boolean {
  if (!answer) return false;
  // Answer-key extraction occasionally stores MCQ keys as
  // "(3) | working explanation". The "(3)" is the actual answer,
  // the suffix is solver commentary that got slurped in. Strip
  // everything past the first " | " before classifying — otherwise
  // the question gets treated as OEQ and the entire MCQ scoring
  // path is skipped (parent dashboard then shows 0 marks and the
  // review UI renders the OEQ layout instead of the option grid).
  const head = (answer.split("|")[0] ?? answer).trim();
  if (!head) return false;
  if (/^\(?[1-4A-Da-d]\)?$/.test(head)) return true;
  // Handle "X or Y" (e.g. "3 or 4", "(1) or (3)")
  // Do NOT split on "/" — it catches fractions like "1/4", "2/3"
  const normalized = head.replace(/[().]/g, "").trim();
  const parts = normalized.split(/\s+or\s+/).map(p => p.trim());
  if (parts.length > 1 && parts.every(p => /^[1-4A-Da-d]$/.test(p))) return true;
  return false;
}

/** Grammar Cloze and Comprehension Cloze answers are words/letters, never MCQ choices.
 *  Even if the answer field is a single letter (e.g. "D"), treat as written. */
function isClozeQuestion(syllabusTopic: string | null | undefined): boolean {
  return syllabusTopic === "Grammar Cloze" || syllabusTopic === "Comprehension Cloze";
}

/** Normalize MCQ answer for comparison: strip parens, drop any explanation
 *  trailing after a " | " separator, uppercase.
 *  Capital "I" is treated as "1" — they are visually identical in handwriting
 *  and "I" is never a valid MCQ option (options are 1–4 or A–D). */
function normalizeMcq(val: string): string {
  // Answer-key extraction sometimes stores MCQ answers as "(4) | working
  // explanation" — split off everything after the first separator before
  // comparing against the student's letter/digit.
  const head = val.split("|")[0] ?? val;
  const upper = head.trim().replace(/[()]/g, "").toUpperCase();
  return upper === "I" ? "1" : upper;
}

/** Parse a flat answer string like "a) X | b) Y" or "(b) foo (c) bar" into
 *  a map of part-label -> answer text. Returns empty map if no part markers.
 *
 *  Labels accepted, in priority order:
 *   - Compound `(a)(i)`, `(a)(ii)`, `(b)(iii)` etc. — Singapore primary
 *     papers commonly use this notation for nested sub-parts. Stored as
 *     "a-i" / "a-ii" / "b-iii" to match the transcribedSubparts label
 *     convention.
 *   - Concatenated `(ai)`, `(aii)`, `(bi)` etc. — older-style nested
 *     label; same dash form on output.
 *   - Plain `(a)`, `(b)`, `(c)` — simple single-letter sub-parts.
 *
 *  IMPORTANT — order matters. We try the compound forms FIRST because
 *  "(a)(i)" naively matches the plain regex twice ("(a)" then "(i)"),
 *  which silently splits the answer into a parent + a separate `i` part
 *  that doesn't exist as a subpart. Previously every (a)(i)-style key
 *  triggered "no answer for sub-part" → solve-on-demand → AI-invented
 *  answer key overwriting the real one. */
export function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!answer || !answer.trim()) return result;
  // Match compound and simple labels separately, then merge by position.
  // Patterns recognised:
  //   "(a)(i)"  / "(a) (i)"      — paren-paren compound
  //   "(a-i)"   / "(a-ii)"       — hyphen compound (storage-shorthand
  //                                  that leaks into answer strings via
  //                                  a partial clone-time rewrite)
  //   "(a)"    / "(b)"            — simple paren label
  //
  // Compound labels are distinctive enough that they DON'T need a
  // leading "^|[|\n]" anchor — the paren-paren / paren-hyphen-roman
  // shape doesn't occur in normal prose. Without this relaxation, a
  // master answer like "(a)(i) K (a)(ii) J | (b) ..." only matched
  // the FIRST "(a)(i)" (anchored by ^) and the second compound was
  // swallowed into part (a)'s content. The focused-test rebuild then
  // emitted broken clones like "(a-i) K (a)(ii) J | (b) ...".
  //
  // Simple labels DO keep the anchor — "(a)" / "(b)" can occur in
  // prose ("Apply rule (a) to the next step"), so we need an explicit
  // separator to call them a label.
  const reCompound = /\s*\(([a-z])(?:\)\s*\(|-)(i{1,4}|iv|v|vi{0,3})\)\s*/gi;
  const reSimple = /(^|[|\n])\s*\(([a-z])\)\s*/gi;
  type Hit = { full: string; index: number; label: string };
  const hits: Hit[] = [];
  for (const m of answer.matchAll(reCompound)) {
    hits.push({ full: m[0], index: m.index!, label: `${m[1].toLowerCase()}-${m[2].toLowerCase()}` });
  }
  // Cover the compound spans so the simple-label scan doesn't re-match
  // the outer "(a)" of an already-recognised "(a)(i)".
  for (const m of answer.matchAll(reSimple)) {
    const idx = m.index!;
    const matchStart = idx + m[1].length;
    const fullEnd = idx + m[0].length;
    const inCompound = hits.some(h => matchStart >= h.index && matchStart < h.index + h.full.length);
    if (inCompound) continue;
    // Trim the leading "|" / "\n" so the slice math lines up with the
    // compound branch above (which has no anchor capture).
    hits.push({ full: m[0].slice(m[1].length), index: matchStart, label: m[2].toLowerCase() });
    void fullEnd;
  }
  hits.sort((a, b) => a.index - b.index);
  if (hits.length === 0) {
    // Last-resort: bare "a)" or "(ai)" concat that the regex above
    // doesn't catch. Kept for backwards-compat with very old answers.
    const reFlat = /(^|[|\n])\s*\(?([a-z](?:i{1,4}|iv|v|vi{0,3})?)\)\s*/gi;
    for (const m of answer.matchAll(reFlat)) {
      hits.push({ full: m[0], index: m.index!, label: m[2].toLowerCase() });
    }
  }
  if (hits.length === 0) return result;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const start = h.index + h.full.length;
    const end = i + 1 < hits.length ? hits[i + 1].index : answer.length;
    const content = answer.slice(start, end).replace(/\s*\|\s*$/, "").trim();
    if (content) result.set(h.label, content);
  }
  return result;
}

/**
 * PSLE OEQ Science answer keys sometimes append "| Explanation: …" as
 * a teacher-facing elaboration — NOT something the student is required
 * to write. Strip that suffix before sending to the AI marker so the
 * model compares handwriting against the required answer, not against
 * marker notes.
 *
 * Gated to PSLE × Science × OEQ only, because other source banks
 * (school WAs, generated quizzes) may include the explanation as part
 * of the expected answer.
 */
function stripExplanationFromAnswer(answer: string | null | undefined): string | null {
  if (!answer) return answer ?? null;
  const m = answer.match(/^([\s\S]*?)\s*\|\s*explanation\s*:[\s\S]*$/i);
  return m ? m[1].trim() : answer;
}

function shouldStripExplanation(
  paper: { subject?: string | null; title?: string | null; level?: string | null } | null | undefined,
  answer: string | null | undefined,
): boolean {
  if (!answer || !paper) return false;
  const subject = (paper.subject ?? "").toLowerCase();
  if (!subject.includes("science")) return false;
  const title = (paper.title ?? "").toLowerCase();
  const level = (paper.level ?? "").toLowerCase();
  if (!title.includes("psle") && !level.includes("psle")) return false;
  // OEQ only — MCQ answers are short tokens like "1" / "(2)" with no
  // explanation suffix, so this check is mostly belt-and-braces.
  if (isMcqAnswer(answer)) return false;
  return true;
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
  // Per-subpart breakdown. When present and non-empty, the server SUMS
  // these to derive marksAwarded — eliminates the "AI declares 4/4 but
  // notes say minus 0.5" disagreement surface. AI may omit on single-part
  // questions; legacy prose-reconciliation runs as a fallback.
  parts?: Array<{ label: string; awarded: number; max?: number }>;
}

// Strip markdown scaffolding the Phase-1 detection AI occasionally
// wraps around its raw transcription:
//   **Part (a)** \n **Transcription** \n ``` <text> ``` \n **Part (b)** ...
// The "**Transcription**" / "**Part (X)**" labels and triple-backtick
// fences are presentation cruft, not the student's actual answer. We
// want the displayed "Detected:" line to show what the student wrote.
function stripDetectScaffolding(s: string): string {
  if (!s) return s;
  return s
    // Remove **Part (a)**, **Part a**, **Part (i)** etc. as standalone lines.
    .replace(/\*\*\s*Part\s*\(?[A-Za-z0-9]+\)?\s*\*\*\s*\n?/gi, "")
    // Remove **Transcription** / **Transcript** / **OCR** labels.
    .replace(/\*\*\s*(?:Transcription|Transcript|OCR|Detected)\s*\*\*\s*\n?/gi, "")
    // Drop fenced code-block markers (```lang and closing ```).
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    // Collapse runs of blank lines left behind by the strips.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build markingNotes string, prefixing with detected student answer when available */
function buildMarkingNotes(result: QuestionMarkResult): string {
  const parts: string[] = [];
  if (result.studentAnswer) {
    // The AI's detect prompt asks for 'Working: ... Final answer: X'.
    // Strip the 'Working:' label so we don't render 'Detected: Working: …'
    // — the label is scaffolding, not part of the answer.
    let cleaned = result.studentAnswer.replace(/^\s*working\s*:?\s*/i, "").trim();
    cleaned = stripDetectScaffolding(cleaned);
    parts.push(`Detected: ${cleaned || result.studentAnswer}`);
  }
  if (result.notes) {
    let notes = result.notes;
    // Drop a leading 'Working:' label too — same scaffolding the AI's
    // detect prompt produces. Without this, 'Detected: X | Working: Y'
    // surfaces twice.
    notes = notes.replace(/^\s*working\s*:?\s*/i, "").trim();
    // Strip the drawable count-diff header (Expected: N. Student: M.
    // Extras: X. Missing: Y.) from the displayed notes — it was only
    // there as a chain-of-thought scaffold for the AI and the
    // server-side clamp at the call site. Marking is reliable now,
    // and parents/students don't need to see the audit numbers.
    notes = notes.replace(/Expected\s*:?\s*\d+\.?\s*Student\s*:?\s*\d+\.?\s*Extras\s*:?\s*\d+\.?\s*Missing\s*:?\s*\d+\.?\s*/gi, "").trim();
    // If the AI restated 'Final answer: X' that's identical to the
    // already-extracted studentAnswer, drop it — duplicate noise that
    // showed up in OEQ science marking notes (often multi-line bullet
    // lists, e.g. 'Final answer:\n- foo\n- bar'). Match dotall so the
    // bullets after the label are captured, then compare normalised.
    if (result.studentAnswer) {
      const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, " ").trim();
      const sa = norm(result.studentAnswer);
      // Tail-anchored 'Final answer:' block — the AI typically puts it
      // at the end of the notes. If its content matches studentAnswer,
      // drop the whole block.
      notes = notes.replace(/\n*\bFinal answer\s*:?\s*\n?([\s\S]+?)\s*$/i, (full, val: string) => {
        return norm(val) === sa ? "" : full;
      }).trim();
    }
    if (notes) parts.push(notes);
  }
  return parts.join(" | ");
}

function englishMarkingRules(subject: string | null | undefined): string {
  if (!subject?.toLowerCase().includes("english")) return "";
  return `
  ENGLISH PAPER MARKING RULES:

  CANCELLED WORDS (English-only — does NOT apply to Math/Science where a stroke across a digit is far more likely to be part of the digit itself than a cancellation): PSLE convention — a clearly crossed-out word is the student's REJECTED attempt and the marker ignores it. Treat clearly cancelled writing as if it were NOT WRITTEN at all.

  What counts as CLEARLY cancelled (ignore the word):
    ✓ One or more horizontal / diagonal strikethrough lines THROUGH the word
    ✓ Multiple scribble strokes drawn ACROSS the word (zig-zag, hatch)
    ✓ Word enclosed in a heavily crossed-out box or with an X through it

  What does NOT count as cancelled (STILL read the word):
    ✗ Underline below the word (that is emphasis, not cancellation)
    ✗ A single dot, tick, or short mark beside the word
    ✗ A stroke from a neighbouring letter that just clips the word
    ✗ Faint marks that do not obscure the letters

  If a cancelled word has a replacement written nearby (above, beside, or below it), treat ONLY the replacement as the student's answer. In notes write: "Cancelled '<oldWord>', read replacement '<newWord>'." If a word is cancelled with NO replacement, treat that portion of the answer as blank — do not award credit for the cancelled writing.

  - MCQ questions (Grammar MCQ, Vocabulary MCQ): no partial marks, exact single-option match only.
  - For ALL written English questions, READ the question text in the image to identify the question type, then apply the rules below.
  - The sections in order after MCQ are: (a) Grammar Cloze, (b) Editing, (c) Comprehension Cloze, (d) Synthesis & Transformation, (e) Comprehension OEQ.

  (a) GRAMMAR CLOZE (select from options A–Q, excluding I and O):
  - A passage with numbered blanks. The student selects a word from a printed word bank labeled A through Q (letters I and O are skipped to avoid confusion with numbers 1 and 0).
  - Most students write a SINGLE LETTER (A–H, J–N, P–Q) in the blank or answer box. Some write the FULL WORD from the bank (e.g. "thereby" instead of just "L"). A subset write BOTH ("L thereby" or "L" above + "thereby" below).
  - STEP 1 — Verify question number: locate the parenthesised number and confirm it matches the question you are marking.
  - **STEP 1.5 — NEAREST-ANSWER RULE (multiple answers visible in the crop)**: The cropped image may contain more than one student answer because adjacent question rows bled into the bound box (e.g. the crop for Q34 also shows Q35's answer right below it). When that happens you MUST pick the answer NEAREST to the printed question number you are marking — not the most legible one, not the first one in reading order. Concretely: identify every blue-ink letter / word in the crop, then identify the printed "(N)" / "QN" anchor for the question you were given. The answer to read is the one whose vertical (and horizontal) distance to that anchor is smallest. Ignore the others — they belong to other questions.
      * Real failure: PSLE English 2025 Q34 — the crop showed both Q34's "G" and Q35's "L"; the marker picked "L" because it was bolder, then scored Q34 wrong. The right read was "G" because "G" sits ON the (34) line.
  - STEP 2 — Blue ink check: look for blue ink written ON or ABOVE the blank or in the answer box. If no blue ink, award 0.
  - STEP 3 — Read answer: transcribe EVERYTHING the student wrote in blue ink **for the question being marked (apply the nearest-answer rule from STEP 1.5 first)** — every isolated letter AND every word, even if both are present. If you see "L" written alone and "thereby" written separately, report BOTH as "L thereby" in studentAnswer. Do NOT discard the letter to keep just the word, or vice-versa. The downstream override layer matches either form against the word bank, so missing one cuts off a valid acceptance path.
  - Compare against the answer key:
      * If the student's transcription contains the correct LETTER (as an isolated A–Q character), award full marks.
      * If the student's transcription contains a word that maps to the correct letter via the printed word bank (e.g. the bank pairs "L" with "thereby"), award full marks. The override layer handles the word-bank lookup; your job is to transcribe accurately.
      * **If FULL PASSAGE CONTEXT is provided (it contains the printed word bank at the top — typically a table of LETTER | WORD entries — plus the passage with every blank inline), use it to confirm word↔letter mapping when the student wrote only the word. Read the bank, find which letter the student's word is paired with, and compare that letter against the answer key.**
      * If neither matches, award 0.
  - NOTE: The letters I and O are NOT used. If you think you see "I" it is likely "J"; if you see "O" it is likely "D", "Q", or "C". Use context and the letter bank to resolve ambiguity.

  (b) EDITING (spelling & grammar correction):
  - The question number is printed BESIDE an answer box. The passage nearby contains an UNDERLINED or MARKED word — this is the erroneous word the student must correct.
  - STEP 1 — Verify question number: locate the printed question number and confirm it matches the question you are marking.
  - STEP 2 — Read the underlined error word: find the underlined/marked word in the printed passage near this question number. Read it carefully. This tells you WHAT KIND of error the student was asked to fix (e.g. a misspelling, wrong tense, wrong form). Log it: "Error word: [word]".
  - STEP 3 — Blue ink check: confirm there is blue ink written INSIDE the answer box. If no blue ink, award 0 marks.
  - STEP 4 — Transcribe letter by letter, stroke by stroke. THIS IS THE MOST CRITICAL STEP — get this right or the whole question is mis-marked. Look at each letter shape carefully and write it down: "x-x-x-x-x".
      * Common handwriting confusions to resolve before deciding: a vs o (closed top loop is "a"; oval is "o"), e vs i (loop with a tail is "e"; single short stroke is "i"), n vs h (two humps no tail is "n"; tall first stroke is "h"), u vs v (rounded base is "u"; pointed V is "v"), c vs e (open curve is "c"; closed loop is "e"), s vs 5, l vs 1 vs I, t vs f, m vs n vs nn, double letters (ll, tt, rr, pp, mm, nn) vs single.
      * Look at letter HEIGHT: ascenders (b, d, f, h, k, l, t) rise above x-height; descenders (g, j, p, q, y) drop below baseline.
      * Look at CONNECTIONS: in cursive, letters may run together — count the humps/loops, don't lose a letter.
      * Do NOT guess the word from the error word or expected answer — transcribe only what the ink physically shows. The whole point of marking is to catch a real spelling slip.
      * If a letter is genuinely ambiguous AND only one reading produces a correctly-spelled word that matches the expected answer, pick that reading and note "Letter X ambiguous between Y and Z — read as Y." Do NOT do this when the ambiguous letter could also be a wrong letter; only when picking gives the student the benefit of the doubt on a legitimately unreadable stroke.
      Log it: "Transcription: [x-x-x-x-x]".
  - STEP 5 — Cross-check against the error word: if the error word looks like a misspelling of the expected answer (e.g. error word is "beleive", expected is "believe"), the student's answer is VERY LIKELY a near-miss spelling attempt. In this case, apply MAXIMUM strictness — even one wrong or missing letter = 0.
  - STEP 6 — Count letters: count letters in your transcription vs expected answer. If counts differ, immediately award 0 (do NOT show letter count in notes).
  - STEP 7 — Compare position by position: for each position, confirm the letter matches exactly. One mismatch = 0.
  - STEP 8 — Award marks only if every letter matches exactly.
  - ALWAYS output this in notes (even for correct answers): "Error word: X | Transcription: x-x-x-x | Match: YES/NO".

  (c) COMPREHENSION CLOZE (fill-in-the-blank, no word bank):
  - A passage with numbered blanks. The student must fill in a suitable word based on context (no options given).
  - The question number is printed in parentheses BELOW the blank line, e.g. (34).
  - STEP 1 — Verify question number: locate the parenthesised number e.g. "(34)" in the crop and confirm it matches the question you are marking. If multiple question numbers are visible, only read the answer for the matching number.
  - **STEP 1.5 — NEAREST-ANSWER RULE (multiple answers visible in the crop)**: The cropped image may contain more than one student answer because the adjacent question row bled into the bound box. When that happens you MUST pick the answer NEAREST to the printed parenthesised number for the question being marked — not the most legible one, not the first one in reading order. Concretely: identify every blue-ink word in the crop, then identify the printed "(N)" anchor for the question you were given. The answer to read is the one whose vertical (and horizontal) distance to that anchor is smallest. Ignore the others — they belong to other questions.
  - STEP 2 — Blue ink check: look for blue ink written ON or ABOVE the blank line that is directly above the matching parenthesised number. If no blue ink is found there, award 0 marks.
  - STEP 3 — Transcribe letter by letter, stroke by stroke. APPLY THE SAME LETTER-BY-LETTER DISCIPLINE AS (b) EDITING — Comp Cloze marking is just as strict on spelling, but the failure mode is the OPPOSITE: instead of reading a correct word as misspelled, the AI silently "auto-corrects" a misspelled word into the expected key. Real failure: student wrote "dipose", AI transcribed it as "dispose" (the contextually-expected verb), and the question was wrongly marked correct. Transcribe what the ink physically shows, NOT what the sentence wants. Look at each letter shape carefully and write it down: "x-x-x-x-x".
      * Common handwriting confusions to resolve before deciding: a vs o, e vs i, n vs h, u vs v, c vs e, double letters (ll, tt, rr, pp, mm, nn) vs single, s vs 5, l vs 1 vs I, t vs f, m vs n vs nn.
      * Look at letter HEIGHT (ascenders b/d/f/h/k/l/t rise above x-height; descenders g/j/p/q/y drop below baseline) and COUNT the humps/loops in cursive — don't lose a letter.
      * Do NOT guess the word from the answer key or from passage context. If the ink shows 6 strokes and the key word has 7 letters, that is a real signal — DO NOT add the missing letter. If a letter is ambiguous but the ambiguity goes against the student (e.g. could be the right letter or a wrong letter), pick the wrong-letter reading.
      * Only resolve ambiguity in the student's favour when the stroke is genuinely unreadable AND the favourable reading produces a real word; never to "rescue" a near-miss into the expected answer.
      Log it: "Transcription: [x-x-x-x-x]".
  - STEP 4 — Count letters: count letters in your transcription vs the answer key. If the counts differ, the student misspelled the word — award 0 (do NOT show the count in notes).
  - STEP 5 — Accept the exact word from the answer key. The answer key represents ONE acceptable answer, not the only one. Accept other words if they (a) are grammatically correct in the sentence, AND (b) preserve the overall meaning of the sentence in context. Slight differences in shade of meaning are fine — PSLE marking accepts a range of contextually valid alternatives. **Use the FULL PASSAGE CONTEXT block (if provided alongside the question — it contains the entire Comp Cloze passage with every blank shown inline) to judge fit against the surrounding sentences and the whole paragraph, NOT just the narrow row crop. If the FULL PASSAGE CONTEXT is provided, you MUST refer to it before rejecting an alternative — many "wrong" student words turn out to be valid synonyms once you see the sentence in full.**
  - **CRITICAL — DO NOT CONFABULATE THE EXPECTED ANSWER**: If you cannot READ a clear handwritten word in the cropped image (the blank is blank, the ink is illegible, the crop shows the wrong row of the passage, or you only see printed text from a different blank), you MUST report studentAnswer as null / "No answer detected" and award 0. NEVER write the answer-key word as studentAnswer when you cannot actually see it written in the student's blue ink. The expected answer in this prompt is what the student SHOULD have written — it is NOT what they DID write. PSLE 2025 Comp Cloze Q46 failure: the row crop showed text from Q48's row, the marker confidently echoed the expected answer "doubt" and awarded 1/1, when the student had written "thoughts" in the (unseen) row above. Detect-then-judge is a real two-step process: STEP A is "what is the blue-ink word in this crop?" (must be answered honestly even when blank), STEP B is "is that word equivalent to the expected answer?". You cannot skip STEP A.
  - Examples that PASS the STEP 5 acceptance:
      * "hesitation" for key "doubt" in "Without any ___, hawker centres come to mind." — both express "immediately / unequivocally" in this context.
      * "until" for key "till" in "Up ___ the 1960s, street hawkers were common." — exact synonyms in this register.
      * "amongst" for key "among" in "___ different immigrant groups". — register variant.
      * "could" for key "able to" when the surrounding tense permits both.
    Do NOT accept answers that change the grammar of the sentence.
  - **GRAMMAR + CONTEXT CHECK (MANDATORY before accepting any non-exact match)**: Before awarding marks to a student's word that differs from the answer key, you MUST verify it parses in the FULL sentence — not just that it shares a meaning with the key. Read the words IMMEDIATELY before and after the blank in the passage; the student's word must fit BOTH grammatically and contextually with them. Common rejection cases the marker has missed in the past:
      * **Article–noun agreement**: "a" before a vowel-sound word, or "an" before a consonant-sound word, is wrong. Real failure: passage said "a ___" and the student wrote "appetite" while the key was "craving" — the marker accepted "appetite" because it meant the same thing, but "a appetite" is ungrammatical (should be "an appetite"). Reject any student word that produces a/an mismatch with the printed article.
      * **Singular/plural agreement**: the printed verb / determiner / pronoun nearby implies a number — e.g. "two ___ were", "this ___", "every ___". Reject a student word whose number breaks that agreement, even if it's a valid synonym in isolation.
      * **Part of speech**: if the slot needs a noun (article + ___, ___ + verb), reject a verb or adjective; if it needs an adverb (___ +ly slot, after a comma+verb), reject a noun. The synonym must be in the right word class for the slot.
      * **Tense / verb form**: matching tense of surrounding verbs and the form (-ing / past-participle / infinitive) required by the auxiliary or modal printed in the passage. "had ___" wants a past participle, not a base verb; "to ___" wants an infinitive.
      * **Preposition agreement**: the printed verb / phrase may require a specific preposition (e.g. "depend ON", "consist OF", "interested IN"). Reject a student word that severs the established collocation in the passage.
    Whenever you reject a student's word under this rule, the notes MUST name the grammar / context mismatch explicitly (e.g. "Rejected 'appetite' for key 'craving' — passage reads 'a ___', requires consonant-sound word; 'appetite' begins with a vowel sound."). Vague rejections like "doesn't fit" are not acceptable.
  - Spelling must be correct. A misspelled word = 0 marks. Do NOT round "dipose" to "dispose", "recieve" to "receive", "befor" to "before", etc. — that is exactly the auto-correction this rule blocks.
  - Be careful with function-word swaps — prepositions, conjunctions, determiners and quantifiers each carry a precise meaning and are often NOT interchangeable even when they sound plausible: "between" vs "among" (two vs many), "in" vs "on" vs "at", "all" vs "every" vs "each", "fewer" vs "less", "many" vs "much", "this/that/these/those", "a" vs "an" vs "the", "since" vs "for", "and" vs "or" vs "but", "who" vs "whom" vs "which" vs "that". Examine the context before accepting any of these as a synonym for the key.
  - MANDATORY notes when the student's word is NOT the exact word in the key (whether you accept it or reject it):
      * If accepting: explain WHY the student's word is grammatically and semantically equivalent in this context. State the key word, the student's word, and the reason. Example: "Accepted 'understand' for key 'grasp' — both mean 'comprehend' here and fit the grammar."
      * If rejecting: state the key word, the student's word, and the reason. Example: "Rejected 'between' for key 'among' — 'between' is used for two items, the passage describes many."
    Notes are REQUIRED whenever student ≠ key. Do not return an empty notes string in that case.

  (d) SYNTHESIS & TRANSFORMATION (sentence rewriting):
  - There is usually one correct rewritten sentence or one accepted form.
  - Award full marks only if the answer is grammatically correct AND preserves the original meaning.
  - Award 0 if meaning is changed, tense is wrong, or key words are missing.
  - **READ THE LINE AS ONE SENTENCE (REPLACES THE OLD "splice the keyword" ALGORITHM)**:
      The synthesis row contains a mix of PRINTED BLACK text (a connecting keyword the student does NOT write) and BLUE INK handwriting (the parts the student fills in around the keyword). The printed keyword sits BETWEEN the blanks on the question paper.

      Old failure mode: the marker would transcribe only the blue ink, end up with a sentence missing the keyword (e.g. "The salesgirl replaced the vase complaint that it had a crack.") and then have to splice the keyword back in from the answer key. The splice logic was unreliable — it often produced "missing 'because of Nisa\\'s'" notes even when the student had written everything around the printed keyword correctly.

      NEW approach: read the row LEFT-TO-RIGHT in natural reading order, treating the printed keyword as part of the sentence in its actual visible position. The transcription you produce for studentAnswer MUST include the printed keyword exactly where it sits on the page, even though it's black, not blue. The student's blue ink + the printed black keyword TOGETHER form the candidate sentence you compare against the answer key.

      Steps:
      1. Identify the printed keyword on the answer row (between or beside the blanks, in black). Note it down literally — e.g. printed keyword = "because of Nisa's".
      2. Read the row left-to-right. Output the FULL sentence as it would read off the page: blue ink + printed black keyword, in their actual positions. Example: blue "The salesgirl replaced the vase", printed "because of Nisa's", blue "complaint that it had a crack." → studentAnswer = "The salesgirl replaced the vase because of Nisa's complaint that it had a crack."
      3. Compare that combined sentence against the answer key:
         - Grammatically + semantically equivalent → FULL marks.
         - Real errors (wrong tense, changed meaning, missing connecting words other than the printed keyword, wrong word order) → award marks per the standard "wrong / partial" judgement.
      4. In notes, when reporting studentAnswer, write the COMBINED sentence — do not flag the printed keyword as "missing" since the student was never supposed to write it.

      Real example that the old splice logic kept failing on: keyword "because of Nisa's", expected "The salesgirl replaced the vase because of Nisa's complaint that it had a crack.", student wrote "The salesgirl replaced the vase" + "complaint that it had a crack." around the printed phrase → studentAnswer should be "The salesgirl replaced the vase because of Nisa's complaint that it had a crack." (the printed phrase is read inline) → FULL marks (2/2). Do NOT mark it as "missing 'because of Nisa\\'s'".
  - APOSTROPHE-S TOLERANCE: When the given word/phrase contains an apostrophe + s (possessive form, e.g. "Nisa's", "the boy's", "the children's", "Mr Tan's"), accept the student's answer if the base name/word appears in the right slot even without the apostrophe-s. A handwritten "'s" is a small tick that the AI transcription routinely drops — penalising the student for what is almost always an OCR loss is wrong. Examples that PASS the keyword check: keyword "Nisa's" + student "Nisa" → accepted; keyword "the boy's bag" + student "the boy bag" → accepted (the apostrophe-s is treated as punctuation under rule above). The MEANING / structure of the rewrite must still be correct; this rule only relaxes the literal-presence test for the possessive marker itself.
  - SPELLING (this is a HANDWRITTEN scanned answer — every word is a deliberate spelling choice by the student). Synthesis is all-or-nothing — no partial marks. ANY misspelled word in the rewritten sentence = 0. Do this AFTER you have transcribed the student's writing exactly. Apply the same letter-by-letter handwriting reading discipline as (b) Editing — don't infer a correctly-spelled word from context, transcribe what the ink physically shows. Ignore punctuation mistakes (missing commas, full stops, missing/extra apostrophes, capitalisation in the middle of the sentence) for now — those don't affect the spelling check.
  - COMPOUND-WORD SPACING IS NOT A SPELLING ERROR. When the student writes a compound word as two separate words (e.g. "sales girl" instead of "salesgirl", "every day" instead of "everyday", "after noon" instead of "afternoon", "ice cream" instead of "icecream") OR the reverse (single word as two), accept it for the spelling check. The component letters are correct in the right order, only the spacing differs. This is a presentation choice that primary students legitimately get wrong both ways without it reflecting on their spelling knowledge. The strict letter-by-letter rule applies WITHIN each word, not to whether two words should fuse into one.
  - In notes when awarding 0 for spelling: state the misspelled word and the correct spelling. Example: "Misspelled 'recieved' (should be 'received') — 0 marks." Do NOT cite "sales girl vs salesgirl" or similar pure-spacing differences as the reason for 0.

  (e) COMPREHENSION OEQ (open-ended, short answer):
  - The answer key gives the expected key point(s).
  - Award full marks if all key points are present in the student's answer.
  - Award PARTIAL marks if some key points are present — even for 1-mark questions, award 0 if the key idea is missing or too vague.
  - Accept synonyms and paraphrases as long as the meaning is preserved.
  - In notes, state which key point was present or missing.
  - NAMED-NOUN STRICTNESS (high failure mode — read carefully): every concrete noun, proper noun, story-specific object, place, and event named in the answer key is a REQUIRED marking point. The student's answer MUST contain that exact noun (or a clear single-word synonym — NOT a vague paraphrase). Missing a named noun = MISSING for that key point.
    Examples of named nouns: "recipe book", "surprise", "birthday party", "the letter", "Mr Tan", "the kitchen", "the gift". A student who writes "she wanted to distract him" instead of "to hide the recipe book / the surprise" has lost BOTH named nouns and scores 0 on a 1-mark question. Award marks ONLY when the named noun (or its direct synonym) is literally present.
    Before awarding any marks: STEP A — list every concrete/named noun in the key. STEP B — for each, check whether it (or a direct synonym) appears in the student's answer. STEP C — if any are missing for a 1-mark question, award 0; for a 2-mark question, deduct one mark per missing named noun.
  - SPELLING (this is a HANDWRITTEN scanned answer). After deciding marks on content, scan the student's answer for misspelled English words. Deduct 0.5 marks for EACH misspelled word, with a floor of 0 (can't go negative). Apply the same letter-by-letter handwriting reading discipline as (b) Editing — transcribe what the ink physically shows, don't infer a correct spelling from context. Ignore punctuation mistakes (missing commas, full stops, apostrophes, mid-sentence capitalisation) for now — punctuation does NOT count as a spelling mistake.
  - In notes when deducting for spelling: list each misspelled word and the correct spelling. Example: "Content full marks (2). Spelling: 'recieved' → 'received', 'beleived' → 'believed'. −1.0 for two spelling mistakes. Final: 1.0."`;
}

/**
 * Strict-marking rules for science OEQ. Applied to BOTH the exam-
 * paper marker (markBatch via SUBJECT_RULES) and the scanned-back
 * quiz/focused marker so a science question scores the same on
 * either path. Covers:
 *
 *   1. Partial-credit ladder for concept-based answers — captures
 *      some concepts → proportional credit, captures none → 0.
 *   2. Key-term requirement — named scientific terms in the answer
 *      key must literally appear in the student's answer (or a
 *      recognised scientific synonym, NOT vague paraphrase).
 *   3. Discriminating terms — when two real scientific terms could
 *      both fit the slot in the sentence (ovule vs ovum, mass vs
 *      weight, evaporation vs condensation, voltage vs current,
 *      respiration vs photosynthesis, transmit vs absorb,
 *      transparent vs translucent), the student MUST use the exact
 *      correct one. A swap to the near-neighbour term scores 0 for
 *      that concept — partial credit does NOT apply.
 *   4. Definition questions — even stricter, all-or-nothing per
 *      discriminating component.
 *
 * The discriminating-terms rule is what makes "egg cell" vs "ovum"
 * vs "ovule" actually score differently, instead of getting a
 * lenient pass because they're all biological terms.
 */
function scienceStrictRules(subject: string | null | undefined): string {
  if (!subject?.toLowerCase().includes("science")) return "";
  return `

SCIENCE MARKING — PHRASE-BY-PHRASE DEDUCTION (THIS OVERRIDES THE GENERIC STEP 5 PARTIAL-CREDIT RULE ABOVE):
For Science questions, IGNORE the generic "proportional × marksAvailable" rule from STEP 5B. Use the phrase deduction process below instead. The answer key has been written by a human marker; EVERY phrase in it is a discrete marking point. Vagueness, paraphrase that loses the key word, or skipping a phrase are ALL deduction-worthy.

═══════════════════════════════════════════════════════════════
ANSWER KEY NOTATION — READ THIS BEFORE ANYTHING ELSE:
═══════════════════════════════════════════════════════════════
The answer key uses two separators with VERY DIFFERENT meanings:

  "|"  (pipe)  = separates DISTINCT marking points. ALL must be present in the student's answer. Each missing pipe-segment costs 0.5 marks.
  "/"  (slash) = alternatives WITHIN a marking point. The student needs ANY ONE.

Example: "After pollination | fertilisation occurs | flower develops into a fruit"
  = THREE distinct marking points, ALL required. Student who writes only "fertilisation" misses 2 out of 3 → -1.0 marks.

Example: "Ovary / Ovaries"
  = ONE marking point with two acceptable spellings. Student writes either → full credit for that point.

Multi-part answers like "(a) ... (b) ... (c) ..." — treat each labelled part independently. Apply phrase segmentation WITHIN each part.

═══════════════════════════════════════════════════════════════
MANDATORY PROCESS — DO NOT SKIP A SINGLE STEP:
═══════════════════════════════════════════════════════════════

STEP A: List every marking point. A marking point is:
  - any pipe-separated "|" segment from the key, OR
  - any semantically discrete clause within a segment that names a distinct fact, named term, function, property, mechanism, or causal link.

STEP B: For each marking point, decide PRESENT or MISSING in the student's answer.
  - PRESENT only if the student's answer contains the actual concept AND any named scientific term in it (or a recognised scientific synonym, NOT a vague everyday paraphrase).
  - "joining of male and female cells" ≠ "fertilisation" (named term lost) → MISSING for the fertilisation point.
  - "water carrying tubes" PRESENT for the structure point but is NOT a function statement → the function point is MISSING.
  - "fruit grows" PRESENT for the "develops into a fruit" point.
  - "breathing" ≠ "respiration" (named term lost) → MISSING.
  - **Anatomical / organ names are SCIENTIFIC TERMS even though they look like everyday English words.** When the answer key in a body-system question names a specific organ (nose, mouth, windpipe / trachea, lungs, heart, stomach, intestines, liver, kidneys, bladder, brain, eye, ear, skin, blood vessels, arteries, veins, etc.) and the student substitutes a vague paraphrase that drops the organ:
      - "takes in oxygen through the **nose**" vs student writing "inhales air" → "nose" MISSING.
      - "oxygen travels to the **lungs**" vs student writing "into the body" → "lungs" MISSING.
      - "pumped by the **heart**" vs student writing "pumped around" → "heart" MISSING.
    Each missing organ name is its own MISSING marking point even if the rest of the sentence's mechanism is right.

EQUIVALENCE / IMPLICATION RULE (IMPORTANT — applies before deduction):
Many answer keys split a single concept across two clauses where one CAUSES or IMPLIES the other. If the student writes either clause, treat BOTH as PRESENT. Do not double-count one concept just because the key wrote two clauses about it.

Specifically, these pairs are EQUIVALENT — student writing either side counts for both:
  - "switch is closed" ⇔ "(electric) current can flow / circuit is complete"
  - "switch is open" ⇔ "current cannot flow / circuit is incomplete / current stops"
  - "circuit is closed" ⇔ "current flows"
  - "rod becomes an electromagnet" ⇔ "rod is magnetised / rod attracts magnetic materials"
  - "bulb lights up" ⇔ "current flows through bulb / bulb is on"
  - "bulb does not light up" ⇔ "no current through bulb / bulb is off"
  - "water is heated" ⇔ "water gains heat / water's temperature rises"
  - "object is opaque" ⇔ "light cannot pass through object / object blocks light"

The general principle: if clause B is the direct mechanical / observational consequence of clause A and a P5–P6 student would treat them as one fact (one is implied by the other in the standard textbook chain), they are ONE marking point. Apply common sense — do not invent equivalences that aren't part of standard primary-school science reasoning.

Apply this BEFORE deciding PRESENT / MISSING. The deduction count is over DISTINCT concepts, not raw "|" segments.

CONTEXT-FROM-STEM RULE (IMPORTANT — applies before deduction):
If the question stem already introduces an entity, setup, scope, or named object, the student does NOT need to repeat it in their answer to score that marking point. The marking point is the NEW assertion / inference / function the student must produce, NOT a re-statement of context already supplied.

Concretely:
  - Stem mentions "two plants" + key says "Part X of both plants absorbs water and mineral salts" → student writes "Part X absorbs water and mineral salts". The phrase "both plants" is established scope from the stem. Do NOT deduct for it — the student's statement applies to the same Part X already named in the stem. ACCEPT as full credit for that point.
  - Stem names the experimental subject (a beaker, a circuit, "the plant", "the boy") and the key repeats it → student answers without re-naming it. Do NOT deduct for the missing subject noun; the referent is unambiguous.
  - Stem describes an observable setup ("X shows the water level after the plasticine is added") + key says "the water level dropped" → the noun "water level" is context; the inference "dropped / decreased / went down" is what the student must produce. If the student concludes the level dropped (in any wording, or via a clear implication), that point is PRESENT. If they reason about something entirely different and never address the level's change, the inference is MISSING — but frame the deduction as "the level-change inference was missing", NOT as "did not say water level".

Default: when in doubt about whether a phrase is stem-context vs new-inference, lean ACCEPT. Penalising students for omitting words the question already gave them is a common false-positive — avoid it.

STEP C: Compute the score:
  marksAwarded = max(0, marksAvailable - 0.5 × numberOfMissingPoints)
  Award 0 outright if NO marking points are PRESENT.

STEP D: Internally apply the per-phrase logic above, but in the notes field write plain feedback for a parent and child to read.

NOTES STYLE — STRICT:
  - One short paragraph, 1–2 sentences total.
  - Lead with what the student got right (briefly).
  - Then say plainly what was missing or wrong, wrapping each missing key phrase / named term in **double asterisks**.
  - End with a one-clause deduction reason like "−0.5 for not stating the function" or "−0.5 because **respiration** was not named".

NOTES — FORBIDDEN PATTERNS (DO NOT USE ANY OF THESE):
  - Labels like "PRESENT", "MISSING", or "marking point (1)/(2)/(3)".
  - Tables or numbered lists of marking points.
  - Scaffolding like "Marking points: (1) X, (2) Y" or "Per-phrase: ..." or "(1) PRESENT (2) MISSING".
  - Score summaries like "Starting 4/4, -0.5 for each MISSING. Awarded 2.5/4." or "Score: 2/3" or "Awarded 1.5/2".
  - ANY restatement of marksAwarded inside the notes — the marks number lives in marksAwarded, not in notes.

These forbidden patterns are debug scaffolding from earlier prompts. The current notes field is read by a primary-school student and their parent — write for them, not for a marker rubric.

WORKED EXAMPLES (style your notes like these — internal scoring still uses the per-phrase rule):

Example 1 — 2-mark, structure + function. Student: "water carrying tub"
  Awarded 1.5/2. Notes: "Correctly named the **water-carrying tubes** but did not state their function. −0.5 for missing **transport water**."

Example 2 — 2-mark, multi-step process. Answer key: "After pollination | fertilisation can occur | flower develops into a fruit." Student: "fertilisation happens and fruit grows"
  Awarded 1.5/2. Notes: "Identified **fertilisation** and that a **fruit** develops, but did not link this to **pollination**. −0.5 for missing the pollination step."

Example 3 — 2-mark, multi-step circulatory. Answer key: "More blood to the muscles | more oxygen and digested food supplied | more energy released / faster respiration." Student: "more blood goes to the muscles so they can move faster"
  Awarded 1/2. Notes: "Correctly said more blood is delivered to the muscles, but didn't mention **oxygen** or **digested food**, and didn't name **respiration** or energy release. −1.0 across two missing points."

Example 4 — 2-mark, vacuum flask. Answer key: "The vacuum is a poor conductor of heat | so heat cannot pass through it." Student: "vacuum keeps it warm"
  Awarded 1/2. Notes: "Mentioned the **vacuum** but did not explain that it is a **poor conductor of heat** and that **heat cannot pass through** it. −1.0 across two missing points."

Example 5 — 2-mark, condensation. Answer key: "Water vapour contacts colder surface | loses heat | condenses to form water droplets." Student: "water vapour touches the cold metal and becomes water"
  Awarded 1.5/2. Notes: "Said the water vapour contacts the cold metal and forms water, but didn't state that it **loses heat** (or **condenses** by name). −0.5 for missing the heat-loss step."

CRITICAL: Do NOT short-circuit. You MUST internally step through every marking point and only award full marks when every point is present in the student's answer. The user-facing notes should be readable, not a table.

KEY-TERM REQUIREMENT (IMPORTANT):
When the expected answer contains a specific scientific TERM that names the underlying concept being tested (e.g. fertilisation, photosynthesis, chlorophyll, evaporation, condensation, respiration, germination, pollination, dissolved, freezing, melting, gravity, friction, conductor, insulator, transparent, opaque, food chain, predator, prey, habitat, community, population, ecosystem, organism, producer, consumer, decomposer, ovum, ovule, sperm, pollen), the student's answer MUST contain that exact term (or a recognised scientific equivalent — NOT a vague everyday paraphrase).
- 'fertilisation' must appear as 'fertilisation' / 'fertilization'. 'joining of male and female cells' is NOT a substitute — it describes the process but doesn't name it. Score 0 for that concept.
- Synonyms allowed only when they are scientifically interchangeable (e.g. 'water vapour' ≈ 'gas form of water'). When in doubt, treat the missing term as missing.
- This rule overrides the synonym leniency above for these named terms — be strict about terminology, lenient about prose around it.

DISCRIMINATING TERMS (IMPORTANT — STRICTEST):
Some scientific terms have close-but-different neighbours that often confuse students. When the answer key uses one term and the student writes a related-but-WRONG term, score it as WRONG for that concept — partial credit does NOT apply, even if the answer is otherwise on-topic.

Examples (this list is not exhaustive — apply the principle to any pair of related terms):
- ovum vs ovule (animal egg cell vs plant egg cell — different reproductive systems)
- ovule vs ovary (the cell vs the structure containing it)
- sperm vs pollen (animal vs plant male gamete)
- mass vs weight (amount of matter vs gravitational force)
- evaporation vs condensation vs boiling (different phase changes)
- voltage vs current (potential difference vs flow rate)
- respiration vs photosynthesis (gas exchange / energy release vs food-making)
- transmit vs absorb vs reflect (light interactions — opposite phenomena)
- transparent vs translucent vs opaque (different light transmission levels)
- conductor vs insulator (opposite electrical / thermal properties)
- predator vs prey (opposite roles in a food chain)
- producer vs consumer vs decomposer (different trophic levels)
- inhale vs exhale (opposite directions of breathing)
- artery vs vein (different blood-vessel types)
- germinate vs reproduce vs grow (different life-cycle stages)
- dissolve vs melt (solute-in-solvent vs solid-to-liquid at temperature)

Rule: if the answer key's discriminating term is X and the student writes a different-but-related Y from the same conceptual family, score that concept as 0 in the partial-credit calculation. State in notes which discriminating term was wrong, wrapped in **double asterisks** (e.g. "Student wrote **ovule** instead of the required **ovum**.").

DEFINITION QUESTIONS (IMPORTANT — STRICT):
When the question asks the student to DEFINE or EXPLAIN what a term means (e.g. "What is a community?", "Define a population", "Explain what a habitat is", "What is photosynthesis?"), the marking is significantly STRICTER than for a regular reasoning question. Definition questions test exact knowledge of a textbook definition, not approximate understanding.

PROCESS:
1. The term being defined is in the QUESTION — the student does not need to repeat it.
2. Read the expected answer and list its DISCRIMINATING COMPONENTS — the parts that distinguish this term from neighbouring concepts (e.g. "different populations" is what distinguishes a community from a population; "in the presence of sunlight" is what distinguishes photosynthesis from other plant processes).
3. Award marks ONLY when the student's answer contains every discriminating component (or its scientifically interchangeable synonym). Vague paraphrase that "captures the gist" does NOT earn marks here.

SCORING TABLE (apply strictly):
- 1-mark definition question: all-or-nothing. Missing ANY discriminating component → 0. Don't award half a mark.
- 2-mark definition question: full marks ONLY if every discriminating component is present. Missing one of two key components → 1. Missing both → 0. An answer that "broadly captures the idea" but no specific terms → 0.
- 3+ mark definition question: deduct one mark per missing discriminating component, never below 0.
`;
}

function chineseMarkingRules(subject: string | null | undefined): string {
  const s = (subject ?? "").toLowerCase();
  const raw = subject ?? "";
  const isChinese = s.includes("chinese") || raw.includes("华文") || raw.includes("中文") || raw.includes("华语");
  if (!isChinese) return "";
  return `
  CHINESE PAPER (华文) MARKING RULES — OVERRIDES "British English" guidance above:
  - The student's answers and the questions are in Simplified Chinese.
  - 阅读理解 OEQ (open-ended comprehension): award marks based on whether the student's 中文 answer captures the required idea. Synonymous phrasings are accepted. Partial credit allowed when marksAvailable > 1.
  - 短文填空 / 阅读理解 MCQ: exact option match (1-4 digit). No partial marks.
  - 完成对话: exact word-bank digit (1-8) match. No partial marks.

  CHINESE 阅读理解 OEQ MARKING — PHRASE-BASED RUBRIC:
  - Answer keys for 阅读理解 OEQ list the expected answer as a series
    of phrases separated by " | " (pipe). EACH SEPARATED PHRASE IS 1
    MARK by default. The phrase count should equal marksAvailable.
    Example: 4-mark answer "在11月29日上午十点 | 在东海岸海滩 | 学习保护环境 | 了解小海龟出生条件"
    → 4 phrases, 1 mark each.

  - ⭐ PARENTHETICAL POINT VALUES — (0.5) / (1) / (2): when a phrase
    in the answer key is followed by a parenthesised mark allocation,
    that number is the MARK VALUE for that specific phrase. The total
    should sum to marksAvailable. Honour these EXACTLY — never override
    with the default "1 mark per phrase" rule.

    Accepted parenthesis styles (the marker keys come from human
    teachers who write them inconsistently):
      · Half-width Latin parens: "(0.5)", "(1)", "(2)"
      · Half-width with 分: "(0.5分)", "(1 分)", "(2分)"
      · Full-width Chinese parens: "（0.5）", "（1）", "（2）"
      · Full-width with 分: "（0.5分）", "（0.5 分）", "（1 分）"
    Treat ALL of these as the same N-mark annotation. Strip any
    surrounding whitespace and the literal character "分" before
    reading the number.

    Examples (all five rows mean the SAME thing — 4 marks split as
    2 / 1 / 1):
      "解释关键 (2) | 给出例子 (1) | 总结 (1)"
      "解释关键 （2） | 给出例子 （1） | 总结 （1）"
      "解释关键 (2分) | 给出例子 (1分) | 总结 (1分)"
      "解释关键 （2 分） | 给出例子 （1 分） | 总结 （1 分）"
      "解释关键 (2) | 给出例子 (1分) | 总结 （1）"  ← mixed styles
      → 4 marks total: point 1 worth 2, points 2 and 3 worth 1 each.

    Half-mark example: "原因A (0.5) | 原因B （0.5 分） | 影响 (1)"
      → 2 marks total: first two points 0.5 each, third point 1.
    For each annotated phrase:
      · Student captures it (synonyms / paraphrases accepted) → full
        N marks.
      · Partially captured (mentions the topic but misses the
        substance) → N/2 marks rounded to the nearest 0.5 (so a
        (2)-point phrase partial gets 1; a (1)-point phrase partial
        gets 0.5; a (0.5)-point phrase partial gets 0).
      · Not captured → 0.
    Phrases WITHOUT a "(N)" tag default to 1 mark each (legacy rule).

  - Score (when NO parenthetical tags are present): for each rubric
    phrase, check if the student's answer contains that phrase OR an
    equivalent idea (synonyms / paraphrases accepted). Award 1 per
    phrase matched; 0.5 if partially captured.

  CHINESE 长 OEQ — OPINION / 你同意吗 QUESTION (4 marks, typically the LAST OEQ in 阅读理解二B):
  - When the question asks for the student's opinion (e.g. "你同意吗？
    试加以说明", "你认为..."), the 4 marks are split as:
      · 1 mark — clear agree / disagree (or "yes / no") stance stated
        at the start.
      · 2 marks — elaboration: TWO distinct supporting reasons drawn
        from the passage or the student's own argument, 1 mark each.
        A student who only gives ONE reason gets 1 of the 2 elaboration
        marks; vague repetition of the stance is 0.
      · 1 mark — conclusion / closing line that restates the position
        or wraps up the argument.
  - In the notes, name each component (stance / 论点1 / 论点2 / 结论)
    and say which were awarded. Missing components lose their marks.
  - Final marksAwarded = sum of awarded components. Clamp to
    [0, marksAvailable]. Round to nearest 0.5.

  ═══════════════════════════════════════════════════════════════════
  CHINESE Q33 — 应用文 (LETTER / EMAIL / 通告 WRITING) — 2 marks 内容 + 2 marks 语言:
  ═══════════════════════════════════════════════════════════════════
  Detection rule (apply BEFORE the phrase-based and opinion rubrics
  above): when the question being marked is "Question 33" on a Chinese
  paper, OR the answer key contains the literal string "评分标准" with
  "内容" + "语言" mark allocations, treat the question as 应用文 /
  letter writing and use the rubric below. DO NOT apply the
  phrase-by-phrase " | " split — the answer key's pipe separators in
  this case are part of a sample letter, not a list of marking points.

  Default split when the answer key omits the explicit 评分标准
  annotation: ASSUME 2 marks 内容 + 2 marks 语言 (i.e. the standard
  Q33 rubric). Do NOT refuse to mark a Q33 answer just because the
  key lacks the (评分标准: 内容X分; 语言Y分) annotation — the
  annotation is optional.

  Q33 is a SHORT FUNCTIONAL TEXT — typically 邀请信 / 通知 / 留言 / 邮件
  / 短信. The student is given a brief stem listing WHICH details the
  letter must contain. The 4 marks split exactly as:

  ─ 内容 (2 marks total) ────────────────────────────────────────
  READ the question stem to identify the required W's — typically a
  combination of WHO (人物 / 收件人), WHAT (什么事 / 什么活动), WHEN
  (时间), WHERE (地点), WHY (原因). Some tasks add HOW or other
  details. Award credit for each required W the student CAPTURES
  (synonyms / paraphrases accepted — exact wording is NOT required).

    · All required W's clearly captured                 → 2 / 2
    · Most captured, one or two missing or vague        → 1.5 / 2
    · Half captured                                     → 1 / 2
    · Only one W or token coverage                      → 0.5 / 2
    · None captured                                     → 0 / 2

  Be flexible: a date like "2025年11月29日" satisfies WHEN, "在东海岸"
  satisfies WHERE, "因为我想了解…" satisfies WHY, etc. The student
  does not need to copy the sample letter — they need to communicate
  the required information.

  ─ 语言 (2 marks total) ────────────────────────────────────────
  START AT 2 / 2 and deduct as follows:
    · 错别字 (wrong character / 别字) — 0.5 off PER instance.
      Cap total 错别字 deduction at 1 mark even if more than two
      错别字 are present (so the worst-case 错别字 hit is -1/2).
    · 病句 / clumsy / ungrammatical / non-idiomatic sentence
      (meaning is unclear, word order is wrong, key connector
      missing) — 0.5 off PER instance.
    · 标点 errors — IGNORE per PSLE marker convention; punctuation
      is not scored on Q33.
    · Foreign / English words inserted where Chinese is required —
      0.5 off PER instance.
  Floor at 0. Round to nearest 0.5.
  Notes for 语言 deductions MUST quote the offending word or
  sentence in 中文引号 「…」 so the parent can spot the issue in
  the student's writing — e.g. 「也理海滩」错别字，应为「清理海滩」。

  ─ Final marks for Q33 ────────────────────────────────────────
  marksAwarded = 内容 + 语言, clamped to [0, 4], rounded to 0.5.

  Notes MUST split the score into TWO parts and use 中文:
    内容: X / 2 — <name each W and whether captured>.
    语言: Y / 2 — <list each deduction with the quoted offender>.

  - LANGUAGE OF OUTPUT — CRITICAL: EVERY string in the "notes" / "feedback" field of your JSON response MUST be written in Simplified Chinese (简体中文). Do NOT respond in English. Do NOT use British English. Numbers and punctuation may stay as printed.
  `;
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

  - SHORT QUESTIONS (marksAvailable ≤ 2): if the final answer matches
    the expected answer → award FULL MARKS immediately. Working is
    NOT required; a student who writes only the correct final answer
    with no working at all still gets full marks. Don't inspect
    working steps unless the final answer is wrong.

  - LONG QUESTIONS (marksAvailable ≥ 3): if the final answer matches
    the expected answer, inspect the working before awarding full
    marks. PSLE awards method marks for the working as well as the
    answer mark — a right answer reached via wrong reasoning is not
    full marks. Use judgment about HOW WRONG the working is:
      · Working is correct, just unusually compact / written
        differently → full marks. Don't penalise neat or terse
        working when it's mathematically sound.
      · One small slip in an intermediate step that the student
        self-corrected later → full marks (the slip didn't change
        the answer).
      · Wrong method or conceptual error in one stage, but the
        student happened to land on the right answer (e.g. arithmetic
        coincidence, lucky guess at the last step, working that
        doesn't connect to the final number) → deduct 1 mark for a
        3- or 4-mark question, up to 2 marks for a 5-mark question.
      · Most of the working is wrong / unrelated and the right
        answer looks plucked from nowhere → deduct up to 2 marks
        (3-mark Qs: cap deduction at 1; 4-mark: up to 2; 5-mark: up to 2).
      · A student who shows NO working at all on a 3+ mark question
        but writes the correct final answer falls under this branch
        too — deduct the same way (method marks weren't earned).
    Always state the working issue in the notes, wrapping the
    specific mistake in **double asterisks**.

  - WRONG FINAL ANSWER (any marksAvailable): scan the student's
    working steps for partial credit. Award partial marks if some
    steps or methods are correct, proportional to marksAvailable.

  - SUB-PART LABEL SWAP: If a multi-part question's expected answers
    per subpart are known (e.g. (a) = 64°, (b) = 67°) AND the student
    wrote BOTH correct values in their answer area but under SWAPPED
    subpart labels (their (a) = 67°, their (b) = 64°), treat this as
    a label mix-up — NOT two wrong answers. Numerically the student
    got both right; the only mistake was the (a)/(b) bookkeeping.
      · If the WORKING shows the student understood which value
        belongs to which subpart (e.g. they wrote the right method
        for ∠ABF and arrived at 64°, then the right method for ∠DAE
        and arrived at 67°, just labelled the final ANS lines in
        the wrong order) → award FULL marks for both subparts and
        flag the label slip in the notes only.
      · If NO working is shown but both correct values appear
        labelled in swapped order → award (marksAvailable − 1) marks
        TOTAL across the two subparts (so a 4-mark question becomes
        3, a 2-mark question becomes 1) — one mark off as a slip.
      · Distribute the awarded marks across the two subparts so each
        subpart's marksAwarded ≤ its marksAvailable. Example for a
        4-mark question (2+2 split) with label-swap and no working:
        award 2 marks for (a) and 1 mark for (b) (or 1 and 2; pick
        whichever keeps each subpart's tally within its cap).
      · In notes: "Student swapped (a)/(b) labels — both numerical
        answers correct, deducted 1 mark for the label mix-up."
    This rule applies ONLY when the student's writing CLEARLY
    contains BOTH expected values. If only one is present, mark
    each subpart normally.

  - If no "Ans:" line is visible, use the last clearly written blue-ink answer in the response area as the final answer.

  ⚠️ WRONG-ANSWER CAP (NON-NEGOTIABLE — enforce after computing partial credit above):
  A wrong final answer can NEVER receive FULL marks. The cap is (marksAvailable − 1). Within that cap, USE JUDGMENT about how much of the solving was correct:
    - 2-mark question wrong → 0 if nothing right, 1 if some method right; **MAX 1**
    - 3-mark question wrong → 0 / 1 / 2 depending on working quality; **MAX 2**
      · 1 mark — student set up the problem reasonably but made an early conceptual or arithmetic error.
      · 2 marks — student got most of the way there; only the very last step or a small arithmetic slip is wrong.
    - 4-mark question wrong → 0 / 1 / 2 / 3 depending on working quality; **MAX 3**
    - 5-mark question wrong → 0 / 1 / 2 / 3 / 4 depending on working quality; **MAX 4**
  Rationale: PSLE math marking always reserves at least 1 "answer mark" that requires the right final answer. Without it, full marks are impossible. But within the remaining marks, partial credit scales with HOW MUCH of the working is correct — a student who set up the right ratios and got the right unit value deserves more than a student who only labelled a diagram.
  In the notes, state which intermediate steps you credited and which you did not.
  - CONCEPT ERRORS: If the student used the wrong formula, method, or operation, wrap the specific error in **double asterisks** in the notes (e.g. "Student used **multiplication** instead of division" or "Wrong formula: used **P = 2l + w** instead of area formula").

  REPRESENTATION STRICTNESS — fraction vs ratio vs decimal:
  These are different mathematical objects. Numerically-similar
  looking answers in the wrong form are NOT correct.

  - If the expected answer is a FRACTION (e.g. "$\\frac{4}{9}$",
    "4/9", "$\\frac{2}{5}$"), and the student writes a RATIO
    using a colon (e.g. "4:9", "2:5"), that is a representation
    error. A fraction "4/9" means "four-ninths" ≈ 0.444; a ratio
    "4:9" means "for every 4, there are 9 — 13 parts total".
    They are NOT equivalent.
    → Mark this part WRONG. Award 0 unless visible working
      shows the correct fractional reasoning (give partial only
      for that working, never for the final ratio).
    → In the notes, wrap the mistake in **double asterisks**, e.g.
      "Student wrote **4:9 (ratio)** instead of the required
      **$\\frac{4}{9}$ (fraction)**."

  - Same the other way: if the expected answer is a RATIO
    ("3:5") and the student writes a fraction ("3/5"), award 0
    — they're different objects.

  - If the expected answer is a fraction and the student writes
    its DECIMAL equivalent (e.g. expected "$\\frac{1}{4}$",
    student "0.25"), accept full marks unless the question text
    explicitly asks for the answer in fraction form (look for
    phrases like "as a fraction", "in the form a/b", "in
    simplest form").

  - SIMPLEST FORM (PSLE convention):
    Fraction answers must be given in SIMPLEST FORM (numerator and
    denominator share no common factor) unless the question text
    explicitly says otherwise. If the expected answer is a fraction
    that is already in simplest form and the student writes a
    NUMERICALLY EQUIVALENT but UNSIMPLIFIED fraction, that's a
    representation error — apply the wrong-answer cap.
      · expected "1/2", student "2/4"  → wrong-answer cap (NOT full marks).
      · expected "3/4", student "9/12" → wrong-answer cap.
      · expected "2/5", student "4/10" → wrong-answer cap.
    Working that visibly arrives at the unsimplified fraction can
    still earn partial credit up to the cap; the missing simplification
    is the only thing keeping it from full marks.
    In the notes, wrap the unsimplified answer in **double asterisks**:
    e.g. "Student wrote **2/4** instead of **1/2** (PSLE expects the
    fraction in simplest form)."
    Two exceptions:
      (i) The question text explicitly relaxes the rule (e.g. "Give
          your answer as a fraction", "Any equivalent fraction is
          accepted") — then accept the equivalent unsimplified form.
      (ii) The expected answer in the answer key is itself NOT in
           simplest form (e.g. key says "2/4") — then the answer key
           sets the bar; accept the student's matching form without
           penalty.
    Mixed numbers in simplest form are also acceptable (e.g. "1 1/2"
    for "3/2") unless the question requires an improper fraction
    specifically.

  UNITS — equivalent units are accepted when the question
  does NOT specify a required unit:

  - Volume:   1 L = 1000 cm³ = 1000 mL. So "1800 cm³" = "1.8 L"
              = "1800 mL". All three accepted unless the question
              explicitly demands a specific unit.
  - Mass:     1 kg = 1000 g.
  - Length:   1 m = 100 cm = 1000 mm; 1 km = 1000 m.
  - Time:     1 h = 60 min = 3600 s.

  CRITICAL — MAGNITUDE must still be correct:
  - "1800 cm³" → student writes "1.8 L"   → ✓ correct (equivalent)
  - "1800 cm³" → student writes "1800 mL" → ✓ correct
  - "1800 cm³" → student writes "18 L"    → ✗ wrong by 10× — DEDUCT
  - "1800 cm³" → student writes "180 cm³" → ✗ wrong magnitude

  When the question specifies a unit (e.g. "Express your answer
  in litres"), apply the unit requirement strictly — even a
  correctly-magnituded answer in the wrong unit drops marks.

  UNIT OMISSION — BENEFIT OF THE DOUBT (PSLE convention):
  - PSLE math papers PRINT the required unit on the answer line
    (e.g. "Ans: ______ litres" or "______ kg"). The student writes
    only the numeric value because the unit is already on the page.
  - If the student writes ONLY the number with NO explicit unit,
    DO NOT penalise for missing units. Treat the number as the
    answer in the printed unit and compare magnitudes. Example:
    expected "8.4 L", student writes "8.4" with nothing after →
    award full marks for the numeric match.
  - If the student EXPLICITLY writes a unit after the number
    (e.g. "8.4 litres", "8.4 L", "8400 ml", "8.4 kg"), the unit
    now counts as part of the answer and MUST be correct:
      · Same unit as expected, right magnitude → full marks.
      · Equivalent unit, right magnitude (per the table above) →
        full marks (e.g. expected "8.4 L", student "8400 ml" ✓).
      · Wrong unit (e.g. expected "8.4 L", student "8.4 kg") →
        wrong-answer cap applies. The student declared the unit;
        getting it wrong is a substantive error, not a slip.
      · Right unit, wrong magnitude → wrong-answer cap applies.
    In the notes, flag the explicit-unit case (e.g. "Student wrote
    **8.4 kg** but the expected unit is **litres**.").`;
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
  const metadata = paper.metadata as { answerPages?: number[]; skipPages?: number[]; normalExtractChinese?: { oeqPadFirstPageIndex?: number; oeqPadPages?: number } } | null;
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
  // Chinese OEQ pad: questions on the appended pad pages have
  // pageIndex >= paper.pageCount. Map those to the post-master
  // submission indices.
  if (submissionPage === -1) {
    const oeqPadFirst = metadata?.normalExtractChinese?.oeqPadFirstPageIndex;
    const oeqPadCount = metadata?.normalExtractChinese?.oeqPadPages ?? 0;
    if (typeof oeqPadFirst === "number" && oeqPadCount > 0) {
      const off = question.pageIndex - oeqPadFirst;
      if (off >= 0 && off < oeqPadCount) submissionPage = submissionIdx + off;
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
      ? await cropPageRegion(pageBuffer, question.yStartPct!, question.yEndPct!, `remarkSingle MCQ Q${question.questionNum}`, question.xStartPct ?? null, question.xEndPct ?? null, paper.subject ?? null)
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
    ? await cropPageRegion(pageBuffer, question.yStartPct!, question.yEndPct!, `remarkSingle Q${question.questionNum}`, question.xStartPct ?? null, question.xEndPct ?? null, paper.subject ?? null)
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
  const answerForPrompt = shouldStripExplanation(paper, question.answer)
    ? stripExplanationFromAnswer(question.answer)
    : question.answer;
  const answerDesc = buildAnswerDesc(answerForPrompt, !!question.answerImageData);
  const marksInfo = question.marksAvailable != null ? `marksAvailable: ${question.marksAvailable}` : `marksAvailable: detect`;
  const printWarning = answerForPrompt
    ? ` ⚠️ WARNING: The text "${answerForPrompt}" may appear PRINTED (black ink) on this page — that is the answer key, NOT the student's handwriting. Only count it if written in BLUE INK by hand.`
    : "";
  const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
  const topicHint = question.syllabusTopic ? ` Section: ${question.syllabusTopic}.` : "";
  const questionLines = `- Question ${question.questionNum} (ID: ${question.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}.${topicHint} Expected answer: ${answerDesc}${printWarning}${cropNote}`;

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

  const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject) + chineseMarkingRules(paper.subject));
  parts.push({ text: prompt });

  const isCloze = question.syllabusTopic === "Grammar Cloze" || question.syllabusTopic === "Comprehension Cloze";
  const isEditing = question.syllabusTopic === "Editing (Spelling & Grammar)";
  // Editing needs strict letter-by-letter OCR — flash-lite was mis-
  // reading "Wasting" as "woting" on Q40 (PSLE English 2025) and the
  // strict spell check then penalised the AI's mis-read, not the
  // student. 2.5-pro reads handwriting accurately enough that the
  // spell check sees what the student actually wrote. Cloze stays on
  // flash-lite because it picks from a fixed list of options — no
  // free-form OCR ambiguity to amplify.
  const remarkModel = isEditing ? "gemini-2.5-pro"
    : isCloze ? "gemini-3.1-flash-lite-preview"
    : "gemini-2.5-flash";
  if (isEditing) console.log(`[marking] Q${question.questionNum} is Editing (Spelling & Grammar) — applying strict letter-by-letter spell check (model: gemini-2.5-pro)`);
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

// Maximum unmarked OEQs we'll let through on the "complete with caveat"
// path. More than this and the paper still falls back to status=failed
// (the parent had better re-mark — partial coverage past 2 questions
// stops being useful).
const MAX_UNMARKED_FOR_CAVEAT = 2;

// Last-resort OpenAI marking attempt for a single OEQ. Called from
// inside the per-OEQ retry loops AFTER every Gemini attempt has
// failed with a 5xx-class transient (504 DEADLINE_EXCEEDED, 503
// UNAVAILABLE, stream cancellations). When OpenAI fallback is wired
// up, this is the "4th attempt" promised to parents — Gemini's three
// tries plus one OpenAI try (translated to gpt-5.4 via the existing
// model map). Returns the response text on success, null otherwise
// (which the caller then funnels into the unmarked-list).
async function tryOpenAIMarkingFallback(
  params: { model: string; contents: unknown; config?: unknown },
  lastErr: unknown,
  label: string,
): Promise<{ text: string } | null> {
  if (!isOpenAIFallbackEnabled()) return null;
  if (!isTransientServerError(lastErr)) return null;
  try {
    console.warn(`[marking] ${label} — Gemini failed with transient 5xx, attempting OpenAI fallback (gpt-5.4)`);
    // Bump the routed Gemini model to the highest tier so the OpenAI
    // mapper picks gpt-5.4 (pro). Keeps the prompt + image parts as-is.
    return await runOpenAIFallback({ ...params, model: "gemini-3.1-pro-preview" }, label);
  } catch (err) {
    console.warn(`[marking] ${label} — OpenAI fallback also failed:`, err);
    return null;
  }
}

// After marking commits and feedbackSummary has been generated, prepend
// a one-line caveat naming any OEQs that could not be marked, so the
// parent sees the warning at the very top of the summary. Only called
// when the paper passed the "1-2 unmarked" complete-with-caveat gate.
async function applyMarkingCaveat(
  paperId: string,
  unmarked: Array<{ questionNum: string }>,
): Promise<void> {
  if (unmarked.length === 0) return;
  const names = unmarked.map(q => `Q${q.questionNum}`);
  const list = names.length === 1
    ? names[0]
    : names.length === 2
    ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const caveat = `⚠️ ${list} couldn't be marked automatically — please review manually.`;
  const after = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { feedbackSummary: true },
  });
  const existing = (after?.feedbackSummary ?? "").trim();
  const combined = existing ? `${caveat}\n\n${existing}` : caveat;
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { feedbackSummary: combined },
  });
  console.warn(`[marking] Paper ${paperId} complete with caveat: ${caveat}`);
}

// One-shot MCQ reconciliation. Walks every question on the paper, and
// for each row that the marker treats as an MCQ (4 transcribed options
// OR a 1-4 digit answer), recomputes marksAwarded purely from the
// stored studentAnswer vs answer string compare and writes the result
// back IF it disagrees.
//
// Why this exists: the silent-bad-marks bug (~May 2026) sometimes left
// completed papers with markingStatus=complete + marksAwarded that
// didn't match what the studentAnswer+answer fields would compute to.
// The old "lazy auto-heal on review-page open" defence fired on every
// GET of those papers, which was both noisy (re-marked the paper on
// every page load) and out of place in the read path.
//
// This version is invoked exactly ONCE at the end of markExamPaper /
// markQuizPaper. The check is deterministic — string compare, not the
// AI — so it can never disagree with itself, which means no re-fire
// loop. Mismatches are written in place with a brief note; no recursion
// into the marker.
async function reconcileMcqMarks(paperId: string): Promise<void> {
  const rows = await prisma.examQuestion.findMany({
    where: { examPaperId: paperId },
    select: {
      id: true, questionNum: true,
      transcribedOptions: true, transcribedOptionImages: true,
      answer: true, studentAnswer: true,
      marksAwarded: true, marksAvailable: true,
    },
  });
  let fixed = 0;
  for (const q of rows) {
    const opts = q.transcribedOptions;
    const imgs = q.transcribedOptionImages;
    const isMcq =
      (Array.isArray(opts) && opts.length === 4) ||
      (Array.isArray(imgs) && imgs.some((o) => !!o)) ||
      (() => {
        const a = (q.answer ?? "").trim().replace(/[().]/g, "");
        return a === "1" || a === "2" || a === "3" || a === "4";
      })();
    if (!isMcq) continue;
    if (q.marksAwarded == null) continue; // skipped — leave it alone
    const studentAns = (q.studentAnswer ?? "").trim().replace(/[().]/g, "").trim();
    const correctAns = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    const acceptable = correctAns.split(/\s+or\s+/).map((p) => p.trim());
    const computedCorrect = studentAns !== "" && acceptable.includes(studentAns);
    const computed = computedCorrect ? (q.marksAvailable ?? 1) : 0;
    if (computed === q.marksAwarded) continue;
    console.warn(`[marking] reconcile Q${q.questionNum} (${q.id}): marksAwarded ${q.marksAwarded} → ${computed} (student="${studentAns}" expected="${correctAns}")`);
    await prisma.examQuestion.update({
      where: { id: q.id },
      data: {
        marksAwarded: computed,
        markingNotes: computedCorrect
          ? `Reconciled: "${studentAns}" matches key "${correctAns}".`
          : `Reconciled: "${studentAns}" does not match key "${correctAns}".`,
      },
    });
    fixed++;
  }
  if (fixed > 0) {
    // Recompute paper score from the up-to-date question marks.
    const after = await prisma.examQuestion.findMany({
      where: { examPaperId: paperId },
      select: { marksAwarded: true },
    });
    const total = after.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    await prisma.examPaper.update({ where: { id: paperId }, data: { score: total } });
    console.log(`[marking] reconcile fixed ${fixed} MCQ rows for ${paperId}, new total=${total}`);
  }
}

export async function markExamPaper(paperId: string): Promise<void> {
  await withMarkRetry("marking", paperId, () => _markExamPaperOnce(paperId));
  try {
    await reconcileMcqMarks(paperId);
  } catch (err) {
    console.warn(`[marking] reconcile pass failed for ${paperId}:`, err);
  }
}

async function _markExamPaperOnce(paperId: string): Promise<void> {
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
                  // X-bounds were missing from the rebuild path — when
                  // a clone landed in structureChanged territory
                  // (questionNum count drifted from master), every
                  // freshly-created clone row lost its per-blank
                  // x-bounds. Subsequent marks then cropped the whole
                  // row instead of the single blank, and per-blank
                  // crops in the review UI fell back to full-width
                  // (David's PSLE English paper Q46-Q50 all showed
                  // null x-bounds despite master having them).
                  xStartPct: mq.xStartPct,
                  xEndPct: mq.xEndPct,
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
          // Structure matches — just sync field values.
          // syllabusTopic + xStartPct/xEndPct were missing from this
          // sync list, so when the master got re-tagged ("Grammar MCQ"
          // / "Vocabulary MCQ") or x-bounds were backfilled, the clone
          // stayed on its stale value. PSLE English 2025 clone had
          // Q1-Q15 syllabusTopic still "Grammar Cloze" (the wrong
          // bucket extraction picked), which made isClozeQuestion
          // return true and routed every MCQ into the writtenQs / OEQ
          // markBatch path — producing the "Working: (no working
          // shown) / Final answer: (3)" multi-question text in
          // studentAnswer instead of the digit-only MCQ detector
          // output. Add all three so the structure-match path catches
          // up on every re-mark.
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
            if (mq.syllabusTopic !== q.syllabusTopic) updates.syllabusTopic = mq.syllabusTopic;
            if (mq.xStartPct !== q.xStartPct) updates.xStartPct = mq.xStartPct;
            if (mq.xEndPct !== q.xEndPct) updates.xEndPct = mq.xEndPct;
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
    const metadata = paper.metadata as { answerPages?: number[]; skipPages?: number[]; normalExtractChinese?: { oeqPadFirstPageIndex?: number; oeqPadPages?: number } } | null;
    const hiddenPageSet = new Set([
      ...(metadata?.answerPages ?? []).map((p: number) => p - 1),
      ...(metadata?.skipPages ?? []).map((p: number) => p - 1),
    ]);
    const submissionIndexMap = new Map<number, number>();
    let submissionIdx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!hiddenPageSet.has(i)) submissionIndexMap.set(i, submissionIdx++);
    }
    // Chinese 阅读理解 OEQ pad: when the print flow appended the
    // pad PDF at the end, the scanned submission will contain those
    // pages right after the (non-hidden) master pages. Q33-Q40 have
    // pageIndex = masterPageCount + padPageOffset, so extend the map
    // with those entries so the marker can locate them.
    const oeqPadFirst = metadata?.normalExtractChinese?.oeqPadFirstPageIndex;
    const oeqPadCount = metadata?.normalExtractChinese?.oeqPadPages ?? 0;
    if (typeof oeqPadFirst === "number" && oeqPadCount > 0) {
      for (let off = 0; off < oeqPadCount; off++) {
        submissionIndexMap.set(oeqPadFirst + off, submissionIdx++);
      }
    }

    // Group questions by original page index
    const byPage = new Map<number, typeof paper.questions>();
    for (const q of paper.questions) {
      if (!byPage.has(q.pageIndex)) byPage.set(q.pageIndex, []);
      byPage.get(q.pageIndex)!.push(q);
    }

    // Y-bound overlap normalization for tightly-packed passage blanks.
    // Extraction occasionally writes overlapping yStart/yEnd for adjacent
    // Comp Cloze / Editing / Grammar Cloze blanks (~1-2% of paper height
    // each pair). When the marker's bottom pad is added, the crop for
    // blank N then spills into blank N+1's row and Gemini reads the
    // wrong word — Q48 detected "without" (Q50's expected) and Q49
    // detected "d much money to start" (multi-line bleed) on PSLE
    // English 2025. Walk same-page x-bound questions in order; when
    // q[i].yEnd > q[i+1].yStart, split the overlap at the midpoint so
    // neither crop reaches into the other. Only applied when x-bounds
    // are set on both — full-width OEQ crops have no neighbor problem
    // because the entire page width is the same row anyway. In-memory
    // patch only; DB rows are untouched.
    // Section passage lookup. metadata.sectionOcrTexts is keyed by
    // section label ("Comprehension Cloze", "Grammar Cloze", "Editing
    // (Spelling & Grammar)") and contains the full passage with every
    // blank inline (e.g. "Without any **(46)________**, hawker..."),
    // captured during extraction. Pass this to the Comp Cloze / Grammar
    // Cloze / Editing marker prompt so it can judge whether an answer
    // fits grammatically and contextually in the FULL paragraph — not
    // just the narrow row crop. Real failure: PSLE English 2025 Q46
    // student wrote "hesitation" for key "doubt" and the marker
    // rejected it because the row crop alone doesn't show enough
    // context to see "hesitation" also works in "Without any ___,
    // hawker centres come to mind." Clone first, master fallback.
    let cloneSectionOcr: Record<string, { ocrText?: string }> | null = null;
    const cloneMetaForOcr = paper.metadata as { sectionOcrTexts?: Record<string, { ocrText?: string }> } | null;
    if (cloneMetaForOcr?.sectionOcrTexts) cloneSectionOcr = cloneMetaForOcr.sectionOcrTexts;
    if (!cloneSectionOcr && paper.sourceExamId) {
      const srcForOcr = await prisma.examPaper.findUnique({
        where: { id: paper.sourceExamId },
        select: { metadata: true },
      });
      const srcMetaForOcr = srcForOcr?.metadata as { sectionOcrTexts?: Record<string, { ocrText?: string }> } | null;
      if (srcMetaForOcr?.sectionOcrTexts) cloneSectionOcr = srcMetaForOcr.sectionOcrTexts;
    }
    const sectionOcrTexts = cloneSectionOcr ?? {};

    for (const qs of byPage.values()) {
      const xBounded = qs.filter(q =>
        q.yStartPct != null && q.yEndPct != null &&
        q.xStartPct != null && q.xEndPct != null
      ).sort((a, b) => (a.yStartPct ?? 0) - (b.yStartPct ?? 0));
      for (let i = 0; i + 1 < xBounded.length; i++) {
        const a = xBounded[i];
        const b = xBounded[i + 1];
        if ((a.yEndPct ?? 0) > (b.yStartPct ?? 0)) {
          const mid = ((a.yEndPct ?? 0) + (b.yStartPct ?? 0)) / 2;
          console.log(`[marking] Y-overlap fix page ${a.pageIndex}: Q${a.questionNum}(${a.yStartPct?.toFixed(1)}-${a.yEndPct?.toFixed(1)}) ↔ Q${b.questionNum}(${b.yStartPct?.toFixed(1)}-${b.yEndPct?.toFixed(1)}) → split at ${mid.toFixed(1)}%`);
          a.yEndPct = mid;
          b.yStartPct = mid;
        }
      }
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
      modelOverride?: string,
      // Optional full-passage context (the section OCR text from
      // metadata.sectionOcrTexts). Appended to the prompt so the
      // marker can judge contextual / grammatical fit against the
      // whole paragraph instead of just the narrow row crop. Only
      // used by Comp Cloze / Grammar Cloze / Editing right now.
      extraContext?: string
    ): Promise<QuestionMarkResult[]> {
      const questionLines = questions
        .map((q) => {
          const yStart = isCropped ? "0%" : (q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown");
          const yEnd = isCropped ? "100%" : (q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown");
          const answerForPrompt = shouldStripExplanation(paper, q.answer)
            ? stripExplanationFromAnswer(q.answer)
            : q.answer;
          const answerDesc = buildAnswerDesc(answerForPrompt, !!q.answerImageData);
          const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const printWarning = answerForPrompt
            ? ` [PRINTED TEXT "${answerForPrompt}" may appear on page — IGNORE unless handwritten in BLUE ink]`
            : "";
          const cropNote = isCropped ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          // Give Gemini the section/topic explicitly so it doesn't have
          // to guess the question type from the cropped image. Grammar
          // Cloze in particular has been mis-classified as Comprehension
          // Cloze, with Gemini rejecting a correct single-letter answer
          // ("'G' is not a valid word") because it applied the wrong
          // rule block. Empty / missing topic falls back to old behaviour.
          const topicHint = q.syllabusTopic ? ` Section: ${q.syllabusTopic}.` : "";
          return `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}.${topicHint} Expected answer: ${answerDesc}${printWarning}${cropNote}`;
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

      const extraNote = extraContext ? `\n\n${extraContext}\n` : "";
      const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines + extraNote).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper?.subject) + scienceStrictRules(paper?.subject) + mathMarkingRules(paper?.subject) + englishMarkingRules(paper?.subject) + chineseMarkingRules(paper?.subject));

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

      // Science exam-paper marking on gemini-3.1-pro-preview.
      // Both flash-2.5 and 3-flash-preview visibly skipped the
      // phrase-by-phrase rule and defaulted to "answer is on-topic
      // → full marks", even with the explicit override clause +
      // structured A→E process + worked examples in the prompt.
      // Pro-tier instruction-following is required to actually
      // segment a science answer key into phrases and deduct per
      // missing phrase. Confirmed by user after testing both flash
      // levels.
      //
      // Math + English unchanged on flash-2.5 — their rules are
      // mechanical (exact match or proportional working-steps)
      // and don't need pro reasoning.
      //
      // Cost impact: ~10× per science OEQ question on the exam
      // path (roughly $0.03 → $0.30 per 20-OEQ science paper).
      // Worth it for phrase-level accuracy parity with a human
      // marker.
      const isScience = (paper?.subject ?? "").toLowerCase().includes("science");
      const defaultModel = isScience ? "gemini-3.1-pro-preview" : "gemini-2.5-flash";
      const model = modelOverride ?? defaultModel;
      try {
        const response = await withTimeout(
          getAI().models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: { responseMimeType: "application/json", temperature: 0.1 },
          }),
          GEMINI_TIMEOUT_MS,
          label
        );
        const text = response.text;
        if (!text) { console.warn(`[marking] Empty Gemini response for ${label}`); return []; }
        // Pro models sometimes return the single-question shape
        // {questionId, marksAwarded, ...} directly instead of the
        // {questions: [...]} wrapper that flash always uses. Handle
        // both shapes so a perfectly-valid pro response doesn't
        // crash the marker on `parsed.questions.length`.
        const parsedAny = extractJson(text) as Record<string, unknown> | null;
        let questions: QuestionMarkResult[] = [];
        if (parsedAny && Array.isArray((parsedAny as { questions?: unknown }).questions)) {
          questions = (parsedAny as { questions: QuestionMarkResult[] }).questions;
        } else if (parsedAny && typeof (parsedAny as { questionId?: unknown }).questionId === "string") {
          // Single-question shape — wrap in array.
          questions = [parsedAny as unknown as QuestionMarkResult];
        } else {
          console.warn(`[marking] Unexpected response shape for ${label}: ${text.slice(0, 200)}`);
          return [];
        }
        console.log(`[marking] ${label} done (${model}) — ${questions.length} results`);
        return questions;
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
          // Per-question CROP setup line suppressed — the per-page
          // "Page N: total=X writtenCrop=Y mcq=Z" summary above
          // already conveys the layout; individual yStart/yEnd values
          // are noise on a 77-Q paper. Restore via DEBUG_MARKING_VERBOSE
          // if a specific question's crop bounds need to be inspected.
          if (process.env.DEBUG_MARKING_VERBOSE === "1") {
            console.log(`[marking]   CROP Q${q.questionNum}: answer="${q.answer}", yStart=${q.yStartPct}, yEnd=${q.yEndPct}`);
          }
        }
        for (const q of mcqQs) {
          // Per-question MCQ "answer=" line suppressed for the same
          // reason as CROP above — the per-page MCQ BLIND DETECTION
          // banner already lists every Q on the page.
          if (process.env.DEBUG_MARKING_VERBOSE === "1") {
            console.log(`[marking]   MCQ Q${q.questionNum}: answer="${q.answer}"`);
          }
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
              const topic = q.syllabusTopic ?? "";
              const isChineseCloze = topic.includes("短文填空") || topic.includes("完成对话") || topic.includes("对话填空");
              const isTightCloze = topic.includes("完成对话") || topic.includes("对话填空");
              const imageBuffer = hasBounds
                ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `MCQ page ${pageIndex} Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null)
                : pageBuffer;
              const imageBase64 = imageBuffer.toString("base64");
              const qForDetect = hasBounds ? { ...q, yStartPct: 0, yEndPct: 100 } : q;
              let detected = await detectMcqAnswers(imageBase64, [qForDetect], `page ${pageIndex} Q${q.questionNum}${isChineseCloze ? " (cn-cloze)" : ""}`, 0.4, new Set(), isChineseCloze);
              let studentAnswer = detected.get(q.id) ?? null;
              // 完成对话 (Chinese dialogue cloze) has very tight printed
              // bounds — sometimes the student's circle / digit sits on
              // the edge and gets clipped. Retry once with the crop
              // padded 3% above + 3% below before giving up.
              if (!studentAnswer && isTightCloze && hasBounds) {
                const yStartPad = Math.max(0, q.yStartPct! - 3);
                const yEndPad = Math.min(100, q.yEndPct! + 3);
                const padded = await cropPageRegion(pageBuffer, yStartPad, yEndPad, `MCQ page ${pageIndex} Q${q.questionNum} +3%`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null);
                console.log(`[marking] MCQ Q${q.questionNum}: 完成对话 first pass null — retry with bounds expanded 3% (${yStartPad.toFixed(1)}% → ${yEndPad.toFixed(1)}%)`);
                detected = await detectMcqAnswers(padded.toString("base64"), [qForDetect], `page ${pageIndex} Q${q.questionNum} retry +3%`, 0.3, new Set(), isChineseCloze);
                studentAnswer = detected.get(q.id) ?? null;
              }
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
                const cropped = await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `batch Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null);
                const croppedBase64 = cropped.toString("base64");

                // Step 1: Pre-check for blue ink. Skip when this is a
                // per-blank crop (x-bounds set) — the crop is too
                // narrow for the ink detector to find enough pixels
                // to confidently say "ink present", so it false-
                // negatives and the question gets marked 0 even when
                // the student wrote the right letter. Real failure:
                // PSLE English 2025 Grammar Cloze Q28/Q30/Q32 all
                // had clear single-letter writing but the cropped-to-
                // x-bound ink check returned no-ink → marks 0,
                // studentAnswer "No answer detected". Defer to the
                // AI marker which sees the crop directly and can
                // decide "blank vs filled" with full context.
                const hasXBounds = q.xStartPct != null && q.xEndPct != null;
                const inkFound = hasXBounds ? true : await hasBlueInk(croppedBase64, `Q${q.questionNum}`);
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

                // Step 2: Mark normally with cropped image.
                // Cloze + Editing force a specific lite model (strict
                // letter checks); Science + Chinese OEQ get the pro
                // model for reliable handwriting detection (Chinese
                // confusable look-alikes 己/已/巳, 末/未, etc. trip the
                // flash model). Math/English OEQs use flash.
                const isGrammarCloze = q.syllabusTopic === "Grammar Cloze";
                const isCompCloze = q.syllabusTopic === "Comprehension Cloze";
                const isEditing = q.syllabusTopic === "Editing (Spelling & Grammar)";
                const isSci = (paper?.subject ?? "").toLowerCase().includes("science");
                const subjLower = (paper?.subject ?? "").toLowerCase();
                const subjRaw = paper?.subject ?? "";
                const isChineseSubject = subjLower.includes("chinese") || subjRaw.includes("华文") || subjRaw.includes("中文") || subjRaw.includes("华语");
                // Chinese OEQ pro-model routing is narrowed to Q33 +
                // Q40 specifically (the comprehension lead-in and the
                // 4-mark opinion question — where confusable
                // characters carry the most weight). All other
                // Chinese OEQs stay on flash to keep cost in check.
                // Strip non-digits from questionNum since the field
                // may be "33a" / "33." / etc.
                const qNumDigit = parseInt(String(q.questionNum ?? "").replace(/[^0-9]/g, ""), 10);
                const isChineseOeq = isChineseSubject && (qNumDigit === 33 || qNumDigit === 40);
                let modelOverride: string | undefined;
                // Grammar Cloze: small/strict model for single-letter
                // option-picker checks.
                // Editing: 2.5-pro — was on flash-lite which misread
                // "Wasting" as "woting" on PSLE English 2025 Q40 and
                // the strict spell check penalised the AI's OCR, not
                // the student. Pro reads handwriting accurately enough
                // that the strict spell check works on the real word.
                // Comp Cloze: 2.5-flash so it can reason about
                // synonyms/context and explain accept/reject — the
                // lite model was silently accepting near-misses
                // (e.g. "between" for "among") with no rationale.
                if (isGrammarCloze) modelOverride = "gemini-3.1-flash-lite-preview";
                // Editing: was 2.5-pro to catch "Wasting → woting"
                // mis-OCRs, but PRO is ~17× the price of flash and
                // adds ~$0.45 per English paper. Handwriting OCR on
                // flash has improved enough that flash now handles
                // Editing well; the eval re-run will confirm. Keep
                // the strict letter-by-letter spell-check rules in
                // the prompt — those weren't pro-specific.
                else if (isEditing) modelOverride = "gemini-2.5-flash";
                else if (isCompCloze) modelOverride = "gemini-2.5-flash";
                else if (isChineseOeq) modelOverride = "gemini-3.1-pro-preview";
                const effectiveModel = modelOverride ?? (isSci ? "gemini-3.1-pro-preview" : "gemini-2.5-flash");
                // Log expensive-model invocations only — the bulk
                // flash/flash-lite call lines are noise once a paper
                // is done. "Expensive" = pro tier or OpenAI fallback;
                // see [[project_marking_logs_cleanup]] memory.
                const isExpensiveModel = effectiveModel.includes("pro");
                if (isExpensiveModel) {
                  const reason = isChineseOeq ? "Chinese OEQ Q33/Q40"
                    : isSci ? "Science strict marker"
                    : "Other";
                  console.log(`[marking] Q${q.questionNum} routed to ${effectiveModel} (${reason})`);
                }
                // Pass the full section passage (from sectionOcrTexts)
                // to the marker for Comp Cloze / Grammar Cloze /
                // Editing so it can judge fit against the whole
                // paragraph context, not just the cropped row.
                let extraContext: string | undefined;
                if (isCompCloze || isGrammarCloze || isEditing) {
                  const passage = q.syllabusTopic ? (sectionOcrTexts[q.syllabusTopic]?.ocrText ?? "") : "";
                  if (passage) {
                    const heading = isCompCloze
                      ? `FULL PASSAGE CONTEXT — use this to judge whether the student's word fits contextually + grammatically in the WHOLE sentence and paragraph (not just the cropped row). Blank (${q.questionNum}) is what you are marking; the other "(N)________" blanks are siblings — ignore their content, only use them as positional cues:`
                      : isGrammarCloze
                      ? `FULL PASSAGE CONTEXT (with WORD BANK at the top and numbered blanks below). Use this to (a) confirm the letter/word the student wrote matches the bank entry for blank (${q.questionNum}), and (b) judge the word's grammatical fit in the surrounding sentence:`
                      : `FULL PASSAGE CONTEXT (the editing passage). The error word for blank (${q.questionNum}) is somewhere in this text; use the surrounding sentence to confirm what KIND of correction the student should have produced:`;
                    extraContext = `${heading}\n\n${passage}`;
                  }
                }
                const initial = await markBatch(croppedBase64, [q], `page ${pageIndex} Q${q.questionNum} (cropped)`, true, modelOverride, extraContext);

                // No-detection fallback (Comp Cloze / Editing /
                // Grammar Cloze only): when the marker returned
                // nothing recognisable as a student answer, retry
                // ONCE with the crop expanded +1% on every border.
                // Tightly-packed per-blank crops sometimes shave the
                // student's handwriting at the edge — David's PSLE
                // English 2025 Q47-Q49 returned no detection on Comp
                // Cloze blanks where the ink visibly sat within the
                // expanded region. We don't retry when the marker
                // returned an actual word (even a wrong one) since
                // that's a real read, not a clip.
                const needsRetry = (isCompCloze || isEditing || isGrammarCloze)
                  && q.xStartPct != null && q.xEndPct != null
                  && q.yStartPct != null && q.yEndPct != null
                  && initial.length > 0
                  && (() => {
                    const r = initial[0];
                    const sa = (r?.studentAnswer ?? "").trim();
                    return !sa || sa === "No answer detected" || sa.toLowerCase() === "blank";
                  })();
                if (needsRetry) {
                  const padPct = 1.0;
                  const yS = Math.max(0, q.yStartPct! - padPct);
                  const yE = Math.min(100, q.yEndPct! + padPct);
                  const xS = Math.max(0, q.xStartPct! - padPct);
                  const xE = Math.min(100, q.xEndPct! + padPct);
                  console.log(`[marking] Q${q.questionNum} no detection on initial crop — retrying with +${padPct}% expansion on all borders (y ${yS.toFixed(1)}-${yE.toFixed(1)}, x ${xS.toFixed(1)}-${xE.toFixed(1)})`);
                  const widerBuffer = await cropPageRegion(pageBuffer, yS, yE, `batch Q${q.questionNum} wider`, xS, xE, paper.subject ?? null);
                  const widerBase64 = widerBuffer.toString("base64");
                  const widened = await markBatch(widerBase64, [q], `page ${pageIndex} Q${q.questionNum} (cropped +1%)`, true, modelOverride, extraContext);
                  if (widened.length > 0) {
                    const wr = widened[0];
                    const wsa = (wr?.studentAnswer ?? "").trim();
                    if (wsa && wsa !== "No answer detected" && wsa.toLowerCase() !== "blank") {
                      console.log(`[marking] Q${q.questionNum} wider retry detected "${wsa}" — using widened result`);
                      return widened;
                    }
                  }
                }
                return initial;
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
            ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `retry Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null)
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
          const answerForPrompt = shouldStripExplanation(paper, q.answer)
            ? stripExplanationFromAnswer(q.answer)
            : q.answer;
          const answerDesc = buildAnswerDesc(answerForPrompt, !!q.answerImageData);
          const retryMarksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          const topicHint = q.syllabusTopic ? ` Section: ${q.syllabusTopic}.` : "";
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${retryMarksInfo}.${topicHint} Expected answer: ${answerDesc}${cropNote}`;

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
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject) + chineseMarkingRules(paper.subject));
          parts.push({ text: prompt });

          const retryReqParams = {
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: { responseMimeType: "application/json", temperature: 0.1 },
          };
          try {
            console.log(`[marking] Retry for Q${q.questionNum} (${q.id})${useCrop ? " [cropped]" : ""}`);
            const response = await withTimeout(
              getAI().models.generateContent(retryReqParams),
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
            // 4th attempt — OpenAI fallback for 5xx-class transients.
            const openaiResp = await tryOpenAIMarkingFallback(retryReqParams, err, `retry Q${q.questionNum}`);
            if (openaiResp?.text) {
              try {
                const parsed = extractJson(openaiResp.text) as { questions: QuestionMarkResult[] };
                const result = parsed.questions.find((r) => r.questionId === q.id) ?? parsed.questions[0];
                if (result) {
                  result.questionId = q.id;
                  console.log(`[marking] Q${q.questionNum} salvaged by OpenAI fallback: ${result.marksAwarded}/${result.marksAvailable}`);
                  return result;
                }
              } catch (parseErr) {
                console.warn(`[marking] OpenAI fallback for Q${q.questionNum} returned unparseable JSON:`, parseErr);
              }
            }
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

    const paperIsScience = (paper.subject ?? "").toLowerCase().includes("science");
    const questionsToVerify = paper.questions.filter((q) => {
      const r = resultMap.get(q.id);
      if (!r) return false;
      // Skip verification for questions already confirmed blank by pre-check
      if (r.notes?.includes("No written answer found")) return false;
      // Skip MCQ — blind detection is already unbiased, re-detection unlikely to differ
      if (isMcqAnswer(q.answer) && !isClozeQuestion(q.syllabusTopic)) return false;
      // Skip Science entirely — the primary marker now runs on
      // gemini-3.1-pro-preview with the phrase-by-phrase rule.
      // The legacy verification pass uses gemini-2.5-flash with
      // the OLD lenient prompt, and "upgrades" any score it
      // judges higher — which silently undid every pro deduction
      // (Q29: pro=2.5/3 → flash verify=3/3 → review shows 3/3).
      // For science, trust the strict marker.
      if (paperIsScience) return false;
      // Skip Grammar Cloze — the deterministic word-bank override at
      // the end of markBatch now both UPGRADES (letter / word in bank
      // matches key → full marks) AND DOWNGRADES (clearly wrong letter
      // → 0) in the same pass. A flash verifier on top of that adds
      // ~10 calls per paper without ever changing the outcome.
      if (q.syllabusTopic === "Grammar Cloze") return false;
      return r.marksAwarded < r.marksAvailable;
    });

    if (questionsToVerify.length > 0) {
      console.log(`[marking] Verification pass: ${questionsToVerify.length} questions with partial/zero marks — re-marking`);

      // Bounded concurrency (8 at a time) — firing 50+ flash calls
      // via Promise.all reliably tripped Gemini's per-minute rate
      // limit and triggered 5xx retries with 5s/10s backoff, which
      // added 1-2 min of wall time to the verify pass. 8 concurrent
      // calls hits the model API hard enough to stay efficient
      // without pushing it past the throttle.
      const VERIFY_CONCURRENCY = 8;
      const verifyResults: Array<QuestionMarkResult | null> = [];
      const runOne = async (q: typeof questionsToVerify[number]): Promise<QuestionMarkResult | null> => {
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
            ? await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `verify Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null)
            : pageBuffer;
          const pageBase64 = imageBuffer.toString("base64");

          const yStart = useCrop ? "0%" : (q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown");
          const yEnd = useCrop ? "100%" : (q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown");
          const answerForPrompt = shouldStripExplanation(paper, q.answer)
            ? stripExplanationFromAnswer(q.answer)
            : q.answer;
          const answerDesc = buildAnswerDesc(answerForPrompt, !!q.answerImageData);
          const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const retryAnswerOneHint = q.answer?.trim() === "1"
            ? ` ⚠️ EXPECTED ANSWER IS "1" — look extra carefully for a single vertical blue stroke. Do NOT report "No answer detected" unless the answer area is completely blank.`
            : "";
          const cropNote = useCrop ? " [IMAGE IS CROPPED TO ANSWER REGION ONLY]" : "";
          const topicHint = q.syllabusTopic ? ` Section: ${q.syllabusTopic}.` : "";
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}.${topicHint} Expected answer: ${answerDesc}${retryAnswerOneHint}${cropNote}`;

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
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote).replace("{SUBJECT_RULES}", scienceCommandWordRules(paper.subject) + mathMarkingRules(paper.subject) + englishMarkingRules(paper.subject) + chineseMarkingRules(paper.subject));
          parts.push({ text: prompt });

          try {
            const orig = resultMap.get(q.id)!;
            // Chinese OEQ verify pass uses pro too — otherwise the pro
            // primary marker's detection of a wrong character gets
            // "upgraded" back to a credit by a flash verify (same
            // failure mode we already see on Science, which is why
            // Science skips verify entirely above).
            const vSubjLower = (paper.subject ?? "").toLowerCase();
            const vSubjRaw = paper.subject ?? "";
            const vIsChinese = vSubjLower.includes("chinese") || vSubjRaw.includes("华文") || vSubjRaw.includes("中文") || vSubjRaw.includes("华语");
            const vQNum = parseInt(String(q.questionNum ?? "").replace(/[^0-9]/g, ""), 10);
            // Mirror the primary marker's narrow Q33/Q40-only routing.
            const vIsChineseOeq = vIsChinese && (vQNum === 33 || vQNum === 40);
            const verifyModel = vIsChineseOeq ? "gemini-3.1-pro-preview" : "gemini-2.5-flash";
            // Only log the per-question verify line when the verify
            // model is expensive (pro tier or above). Flash verifies
            // are the common case and just create noise. The end-of-
            // pass "Verification complete: N upgraded" line still
            // reports the aggregate.
            if (verifyModel.includes("pro")) {
              console.log(`[marking] Q${q.questionNum} verify on ${verifyModel} (original ${orig.marksAwarded}/${orig.marksAvailable})`);
            }
            const response = await withTimeout(
              getAI().models.generateContent({
                model: verifyModel,
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
      };
      // Process questions in chunks of VERIFY_CONCURRENCY at a time.
      // Order doesn't matter — verifyResults is read by questionId
      // below, not by index.
      for (let i = 0; i < questionsToVerify.length; i += VERIFY_CONCURRENCY) {
        const chunk = questionsToVerify.slice(i, i + VERIFY_CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(runOne));
        for (const r of chunkResults) verifyResults.push(r);
      }

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
          // "Verify KEPT original" suppressed — the aggregate at the
          // end ("Verification complete: N/M upgraded") already
          // implies that everything else was kept.
          if (process.env.DEBUG_MARKING_VERBOSE === "1") {
            console.log(`[marking] Verify KEPT original for Q${vr.questionId}: verify=${vr.marksAwarded}, original=${original.marksAwarded}`);
          }
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
          const imageBuffer = await cropPageRegion(pageBuffer, q.yStartPct, q.yEndPct, `mcqRetry Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null);
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

    // ── MCQ verify-on-wrong pass ──────────────────────────────────
    // Double-confirm scanned MCQ detections that came back wrong.
    // Re-crop tight to the question and re-detect with 3.1-flash
    // (a different model from the primary 2.5-flash, for a true
    // second opinion). If the verify reads a different digit AND
    // that digit matches the expected answer, accept it. If verify
    // confirms the original (or reads something else still wrong),
    // keep the original mark.
    const verifyResultMap = new Map<string, QuestionMarkResult>();
    for (const r of allResults) verifyResultMap.set(r.questionId, r);
    const mcqToVerify = paper.questions.filter((q) => {
      if (!isMcqAnswer(q.answer) || isClozeQuestion(q.syllabusTopic)) return false;
      if (q.yStartPct == null || q.yEndPct == null) return false;
      const r = verifyResultMap.get(q.id);
      if (!r) return false;
      // Only verify when marked wrong AND something was detected
      if ((r.marksAwarded ?? 0) > 0) return false;
      if (!r.studentAnswer || r.studentAnswer === "No answer detected") return false;
      const expected = normalizeMcq(q.answer ?? "");
      const got = normalizeMcq(r.studentAnswer);
      return !!expected && !!got && expected !== got;
    });
    if (mcqToVerify.length > 0) {
      console.log(`[marking] MCQ verify pass: ${mcqToVerify.length} wrong MCQs to second-opinion (3.1-pro-preview)`);
      const verifyResults = await Promise.all(
        mcqToVerify.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try { pageBuffer = await fs.readFile(pagePath); }
          catch { return null; }
          const imageBuffer = await cropPageRegion(pageBuffer, q.yStartPct!, q.yEndPct!, `mcqVerify Q${q.questionNum}`, q.xStartPct ?? null, q.xEndPct ?? null, paper.subject ?? null);
          const croppedQ = { ...q, yStartPct: 0, yEndPct: 100 };
          const detected = await detectMcqAnswers(
            imageBuffer.toString("base64"),
            [croppedQ],
            `mcqVerify Q${q.questionNum}`,
            0
          );
          const verifyAns = detected.get(q.id) ?? null;
          if (!verifyAns) return null;
          const orig = verifyResultMap.get(q.id)!;
          const expected = q.answer?.trim() ?? "";
          const verifyMatch = normalizeMcq(verifyAns) === normalizeMcq(expected);
          const origAns = orig.studentAnswer ?? "";
          console.log(`[marking] MCQ verify Q${q.questionNum}: original="${origAns}", verify="${verifyAns}", expected="${expected}", verifyMatch=${verifyMatch}`);
          if (verifyMatch && normalizeMcq(verifyAns) !== normalizeMcq(origAns)) {
            return {
              questionId: q.id,
              marksAvailable: q.marksAvailable ?? 1,
              marksAwarded: q.marksAvailable ?? 1,
              studentAnswer: verifyAns,
              notes: `Detected (verified): ${verifyAns} | Correct (original read "${origAns}" — second-opinion 3.1-pro-preview confirmed "${verifyAns}")`,
            } as QuestionMarkResult;
          }
          return null;
        })
      );
      let verifiedUpgraded = 0;
      for (const vr of verifyResults) {
        if (!vr) continue;
        const idx = allResults.findIndex((x) => x.questionId === vr.questionId);
        if (idx !== -1) { allResults[idx] = vr; verifiedUpgraded++; }
      }
      console.log(`[marking] MCQ verify complete: ${verifiedUpgraded}/${mcqToVerify.length} corrected`);
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
    const qById = new Map(paper.questions.map(q => [q.id, q]));

    let totalAwarded = 0;
    const questionUpdates = [...validResults.values()].map((result) => {
      // Keep pre-set marksAvailable if it exists; otherwise use Gemini's detected value
      const existingMarks = presetMarks.get(result.questionId);
      // Persist the detected studentAnswer so the review page can show
      // "Your answer: X" without having to scrape Detected: out of the
      // notes. Skip the marker's "No answer detected" sentinel — we
      // want the field to stay null in that case so the inline
      // renderers treat it as blank.
      const detected = result.studentAnswer && result.studentAnswer !== "No answer detected"
        ? result.studentAnswer
        : null;
      // Deterministic override for Grammar Cloze: the answer is a
      // single letter (A–Q) from the word bank, so once Gemini has
      // detected the letter, the score is decided purely by string
      // match against the key. Gemini has historically rejected
      // correct single-letter answers ("'G' is not a valid word")
      // when it falls back to comp-cloze rules from the image alone.
      // Force-correct here so a confidently-detected letter that
      // matches the key always scores full marks. Same for Chinese
      // 完成对话 which uses digit keys 1–8.
      const q = qById.get(result.questionId);
      const topic = (q?.syllabusTopic ?? "").toLowerCase();
      const rawTopic = q?.syllabusTopic ?? "";
      const isChineseDialogueCloze = rawTopic.includes("完成对话") || rawTopic.includes("对话填空");
      const isGrammarClozeQ = (topic.includes("grammar") && topic.includes("cloze")) || isChineseDialogueCloze;
      let finalAwarded = result.marksAwarded ?? 0;
      let finalNotes = buildMarkingNotes(result);
      const finalAvailable = (existingMarks ?? result.marksAvailable) ?? 0;
      if (isGrammarClozeQ && detected && finalAvailable > 0) {
        // Grammar Cloze marking is DETERMINISTIC: the answer is a
        // single letter (A–Q for English, 1–8 for Chinese 完成对话)
        // from a word bank. Once Gemini has detected what the
        // student wrote, the score is decided purely by string
        // match against the key. We override the AI's verdict in
        // BOTH directions:
        //   - matched but AI awarded 0 → upgrade to full (covers
        //     the historic "Gemini rejected a correct letter as
        //     'not a word'" bug).
        //   - NOT matched but AI awarded full → downgrade to 0
        //     (covers PSLE English 2025 Q31 / Q34: AI confidently
        //     awarded 1/1 to "K" against key "N" and to "L"
        //     against key "G" with no rationale).
        const keyRaw = q?.answer ?? "";
        const acceptable = new Set(
          (isChineseDialogueCloze
            ? (keyRaw.match(/\b[1-9]\b/g) ?? [])
            : (keyRaw.match(/\b[A-Za-z]\b/g) ?? []).map(l => l.toUpperCase()))
        );
        const detectedKey = isChineseDialogueCloze
          ? (detected.match(/\b[1-9]\b/) ?? [""])[0]
          : (detected.toUpperCase().match(/\b[A-Z]\b/) ?? [""])[0];
        let matched = !!detectedKey && acceptable.has(detectedKey);
        let matchedVia: "letter" | "word" | null = matched ? "letter" : null;
        let matchedWordLetter: string | null = null;
        // Tracks whether we could actually parse the word bank — used
        // to decide whether a "no word-form match" verdict is reliable
        // enough to downgrade an AI overcredit, or whether we should
        // trust the AI (passage missing → we can't verify either way).
        let wordBankSize = 0;

        // Word-form fallback (English Grammar Cloze only). Students
        // sometimes write the word from the bank instead of just the
        // letter — e.g. "thereby" instead of "L" on PSLE English
        // 2025 Q35. The strict letter-match above rejects "thereby"
        // even though it's the bank's exact entry for L. Parse the
        // word bank from the section passage (stored as a 2-row
        // markdown table on _passage subpart by the clean-extract
        // step) and accept the word form too.
        if (!matched && !isChineseDialogueCloze && detected) {
          const subs = (q?.transcribedSubparts as Array<{ label: string; text: string }> | null) ?? null;
          const passageText = subs?.find(s => s.label === "_passage")?.text ?? "";
          if (passageText) {
            // Parse the word bank table: rows of `| A | the | B | of | …`
            // shape. Two layouts in prod: separate letter row + word
            // row (4 cols), or letter-word pairs interleaved across
            // columns (8 cols).
            const wordToLetter = new Map<string, string>();
            const tableLines = passageText.split("\n").filter(l => /^\s*\|/.test(l) && /\|\s*$/.test(l));
            // Strip the markdown separator row (| --- | --- |) which
            // would otherwise be parsed as letters.
            const dataRows = tableLines.filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l));
            const parsedRows = dataRows.map(l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
            // Header layout: row[0] = letters, row[1] = words. Plus
            // optional row[2] / row[3] for the second half of the bank.
            for (let r = 0; r + 1 < parsedRows.length; r += 2) {
              const letters = parsedRows[r];
              const words = parsedRows[r + 1] ?? [];
              for (let c = 0; c < letters.length; c++) {
                const letter = letters[c]?.toUpperCase().trim();
                const word = words[c]?.toLowerCase().trim();
                if (letter && word && /^[A-Z]$/.test(letter)) {
                  wordToLetter.set(word, letter);
                }
              }
            }
            wordBankSize = wordToLetter.size;
            const detectedWord = detected.toLowerCase().trim();
            const letterForDetectedWord = wordToLetter.get(detectedWord);
            if (letterForDetectedWord && acceptable.has(letterForDetectedWord)) {
              matched = true;
              matchedVia = "word";
              matchedWordLetter = letterForDetectedWord;
            }
          }
        }

        // Conditions for the bi-directional override:
        //   - matched + AI undermarked → upgrade
        //   - NOT matched + AI awarded marks → downgrade, BUT ONLY
        //     when we are CONFIDENT the student's answer doesn't fit.
        //     "Confident" means: (a) detected is a clear single
        //     letter that we can compare to the key directly, OR
        //     (b) we parsed the word bank successfully and the
        //     detected word is not the bank entry for the key.
        //     When the passage wasn't extracted (wordBankSize === 0)
        //     and detected isn't a clear letter, we can't tell —
        //     trust the AI rather than wrongly downgrade legitimately
        //     correct word-form answers (Q35 "thereby" → L, Q32
        //     "upon" → P on PSLE English 2025).
        const definitelyWrong = !matched && (
          !!detectedKey                          // clear letter that doesn't match
          || (!isChineseDialogueCloze && wordBankSize > 0)  // word bank checked, word didn't fit
        );
        if (matched && finalAwarded < finalAvailable) {
          if (matchedVia === "word") {
            console.log(`[marking] Grammar Cloze word-form match Q${q?.questionNum}: detected "${detected}" = letter "${matchedWordLetter}" in word bank, matches key "${[...acceptable].join("/")}" — upgrading ${finalAwarded} → ${finalAvailable}`);
            finalNotes = `Detected: ${detected} (matches "${matchedWordLetter}" in word bank) | Correct`;
          } else {
            console.log(`[marking] Grammar Cloze override Q${q?.questionNum}: detected "${detectedKey}" matches key "${[...acceptable].join("/")}" — upgrading ${finalAwarded} → ${finalAvailable}`);
            finalNotes = `Detected: ${detected} | Correct`;
          }
          finalAwarded = finalAvailable;
        } else if (definitelyWrong && finalAwarded > 0) {
          console.log(`[marking] Grammar Cloze override Q${q?.questionNum}: detected "${detected}" does NOT match key "${[...acceptable].join("/")}" — downgrading ${finalAwarded} → 0`);
          finalNotes = `Detected: ${detected} | "${detectedKey || detected}" does not match key "${[...acceptable].join("/")}"`;
          finalAwarded = 0;
        }
      }
      totalAwarded += finalAwarded;
      return prisma.examQuestion.update({
        where: { id: result.questionId },
        data: {
          marksAwarded: finalAwarded,
          marksAvailable: existingMarks ?? result.marksAvailable,
          markingNotes: finalNotes,
          ...(detected ? { studentAnswer: detected } : {}),
        },
      });
    });

    // Commit per-question updates first, then derive score + completeness
    // from the freshly-committed state. Same guard as markQuizPaper —
    // never trust the in-memory totalAwarded counter, and refuse to claim
    // "complete" if any non-skipped question is missing a verdict.
    if (questionUpdates.length > 0) await prisma.$transaction(questionUpdates);

    const finalState = await prisma.examQuestion.findMany({
      where: { examPaperId: paperId },
      select: { id: true, questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true, studentAnswer: true },
    });

    // Tabulation safety net — see markQuizPaper for full rationale.
    // Re-parse per-part "Awarded N mark(s)." lines from notes and
    // re-sync marksAwarded to the sum. The marker has layered overrides
    // (parts[] sum, prose-sum, blank-subpart clamp, drawable clamp),
    // and each layer has at some point silently overwritten a later
    // layer's correct verdict. The contract students/parents care
    // about is the per-part marks shown in the notes — make them
    // authoritative server-side.
    {
      const tabFixes: { id: string; questionNum: string; before: number; after: number }[] = [];
      const tabUpdates: ReturnType<typeof prisma.examQuestion.update>[] = [];
      for (const q of finalState) {
        if (!q.markingNotes) continue;
        const marksAvailable = q.marksAvailable ?? 0;
        if (marksAvailable <= 0) continue;
        const sepIdx = q.markingNotes.indexOf(" | ");
        const notesStr = sepIdx >= 0 ? q.markingNotes.slice(sepIdx + 3) : q.markingNotes;
        const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
        const partAwards: { label: string; awarded: number }[] = [];
        for (const m of notesStr.matchAll(partRe)) {
          const chunk = m[2];
          const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
          if (!awardMatch) continue;
          partAwards.push({ label: m[1].toLowerCase(), awarded: parseFloat(awardMatch[1]) });
        }
        if (partAwards.length < 2) continue;
        const proseSum = Math.min(marksAvailable, partAwards.reduce((s, p) => s + Math.max(0, p.awarded), 0));
        const stored = q.marksAwarded ?? 0;
        if (Math.abs(proseSum - stored) < 0.0001) continue;
        tabFixes.push({ id: q.id, questionNum: q.questionNum, before: stored, after: proseSum });
        tabUpdates.push(prisma.examQuestion.update({ where: { id: q.id }, data: { marksAwarded: proseSum } }));
        q.marksAwarded = proseSum;
      }
      if (tabUpdates.length > 0) {
        console.warn(`[marking] Paper ${paperId} tabulation safety net resynced ${tabUpdates.length} question(s) from notes prose-sum: ${tabFixes.map(f => `Q${f.questionNum}: ${f.before}→${f.after}`).join(", ")}`);
        await prisma.$transaction(tabUpdates);
      }
    }

    // Cloze safety net — for Grammar Cloze / Comp Cloze / Editing
    // questions where the marker landed at 0 marks but the stored
    // studentAnswer exactly matches the answer key, force-correct.
    // Catches the cascade where the blue-ink check false-negatives
    // on a tight per-blank crop → 0 marks + studentAnswer reset to
    // "No answer detected", but a prior pass had already written a
    // correct letter / word to DB and that value survives the partial
    // update. Same idea as the prose-sum tabulation net above but
    // scoped to short-answer cloze sections where exact text match
    // IS the marking rule. Also catches mid-run anomalies (verify
    // pass kept original 0 when the AI's own re-detection said the
    // answer was correct).
    {
      const clozeFixes: { id: string; questionNum: string; before: number; after: number; reason: string }[] = [];
      const clozeUpdates: ReturnType<typeof prisma.examQuestion.update>[] = [];
      // Fetch full question records — finalState doesn't include
      // syllabusTopic or answer, both needed to decide cloze status.
      const fullQs = await prisma.examQuestion.findMany({
        where: { examPaperId: paperId, marksAwarded: { lt: prisma.examQuestion.fields.marksAvailable } },
        select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true, studentAnswer: true, answer: true, syllabusTopic: true, transcribedSubparts: true },
      });
      function norm(s: string | null | undefined): string {
        return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      }
      for (const q of fullQs) {
        const topic = (q.syllabusTopic ?? "").toLowerCase();
        const isGrammarCloze = topic.includes("grammar") && topic.includes("cloze");
        const isCompCloze = topic.includes("comprehension") && topic.includes("cloze");
        const isEditing = topic.includes("editing");
        if (!isGrammarCloze && !isCompCloze && !isEditing) continue;
        const stored = q.marksAwarded ?? 0;
        const avail = q.marksAvailable ?? 0;
        if (avail <= 0 || stored >= avail) continue;
        const detected = q.studentAnswer;
        if (!detected || detected === "No answer detected") continue;
        const detectedNorm = norm(detected);
        const keyNorm = norm(q.answer);
        if (!detectedNorm || !keyNorm) continue;

        // Direct text match (case-insensitive, alphanumeric only)
        let matched = detectedNorm === keyNorm;
        let reason = "exact match";

        // Grammar Cloze word-form: if detected is a word from the bank
        // matching the key letter, accept. Parse word bank from
        // transcribedSubparts._passage.
        if (!matched && isGrammarCloze) {
          const subs = (q.transcribedSubparts as Array<{ label: string; text: string }> | null) ?? null;
          const passage = subs?.find(s => s.label === "_passage")?.text ?? "";
          if (passage) {
            const tableLines = passage.split("\n").filter(l => /^\s*\|/.test(l) && /\|\s*$/.test(l));
            const dataRows = tableLines.filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l));
            const parsedRows = dataRows.map(l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
            const wordToLetter = new Map<string, string>();
            for (let r = 0; r + 1 < parsedRows.length; r += 2) {
              const letters = parsedRows[r];
              const words = parsedRows[r + 1] ?? [];
              for (let c = 0; c < letters.length; c++) {
                const letter = letters[c]?.toUpperCase().trim();
                const word = letters[c + 1] ? norm(words[c]) : norm(words[c]);
                if (letter && word && /^[A-Z]$/.test(letter)) wordToLetter.set(word, letter);
              }
            }
            const letterForDetected = wordToLetter.get(detectedNorm);
            const keyLetter = (q.answer ?? "").trim().toUpperCase().match(/\b[A-Z]\b/)?.[0];
            if (letterForDetected && keyLetter && letterForDetected === keyLetter) {
              matched = true;
              reason = `word "${detected}" = letter "${letterForDetected}" in bank`;
            }
          }
        }

        if (matched) {
          clozeFixes.push({ id: q.id, questionNum: q.questionNum, before: stored, after: avail, reason });
          clozeUpdates.push(prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: avail, markingNotes: `Detected: ${detected} | Correct (cloze safety net: ${reason})` },
          }));
        }
      }
      if (clozeUpdates.length > 0) {
        console.warn(`[marking] Paper ${paperId} cloze safety net resynced ${clozeUpdates.length} question(s): ${clozeFixes.map(f => `Q${f.questionNum}: ${f.before}→${f.after} (${f.reason})`).join(", ")}`);
        await prisma.$transaction(clozeUpdates);
        // Refresh finalState's local copy so the score reduce sees the upgrades
        for (const fix of clozeFixes) {
          const fs = finalState.find(f => f.id === fix.id);
          if (fs) fs.marksAwarded = fix.after;
        }
      }
    }

    const finalScore = finalState.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    const unmarked = finalState.filter(q =>
      q.studentAnswer !== "__SKIPPED__" &&
      (q.marksAwarded == null || q.markingNotes == null)
    );
    // Three-way policy (mirrors markQuizPaper):
    //   0 unmarked → complete.
    //   1-2 unmarked → complete with caveat prepended to feedbackSummary.
    //   3+ unmarked → fail the whole paper.
    if (unmarked.length > MAX_UNMARKED_FOR_CAVEAT) {
      console.error(`[marking] Paper ${paperId} has ${unmarked.length} questions with no marking output: ${unmarked.map(q => `Q${q.questionNum}`).join(", ")} — marking as failed`);
      await prisma.examPaper.update({
        where: { id: paperId },
        data: { score: finalScore, markingStatus: "failed" },
      });
      return;
    }
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { score: finalScore, markingStatus: "complete" },
    });
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
    console.log(`[marking] Paper ${paperId} marked complete. Score: ${finalScore}`);

    // Auto-generate summary if instantFeedback is enabled (paper stays "complete" for parent review)
    if (paper.instantFeedback) {
      console.log(`[marking] instantFeedback=true — auto-generating summary for ${paperId}`);
      try {
        await generateFeedbackSummary(paperId);
      } catch (err) {
        console.error(`[marking] Auto-summary failed for ${paperId}:`, err);
      }
    }

    // Prepend the "couldn't mark Q…" caveat to feedbackSummary. Runs
    // regardless of instantFeedback — the warning is useful whether the
    // summary was auto-generated now or will be generated on parent
    // release. No-op when unmarked is empty.
    await applyMarkingCaveat(paperId, unmarked);

    // Auto-release if 100% score and student has skipReviewPerfect enabled
    const examTotalAvailable = [...validResults.values()].reduce((s, r) => s + (r.marksAvailable ?? 0), 0);
    if (examTotalAvailable > 0 && finalScore >= examTotalAvailable && paper.assignedToId) {
      const student = await prisma.user.findUnique({ where: { id: paper.assignedToId }, select: { settings: true } });
      const sSettings = (student?.settings ?? {}) as Record<string, unknown>;
      if (sSettings.skipReviewPerfect === true) {
        await prisma.examPaper.update({ where: { id: paperId }, data: { markingStatus: "released" } });
        console.log(`[marking] Paper ${paperId} auto-released (100% score, skipReviewPerfect=true)`);
      }
    }
  } catch (err) {
    // Only flip to "failed" if marking hadn't already committed.
    // The auto-release block runs AFTER the main transaction sets
    // status="complete"; if it throws on a Gemini 429 / DB hiccup,
    // we mustn't clobber a successful mark. Same guard pattern in
    // markFocusedTest and markQuizPaper below.
    const current = await prisma.examPaper.findUnique({
      where: { id: paperId }, select: { markingStatus: true },
    });
    if (current?.markingStatus === "complete" || current?.markingStatus === "released") {
      console.warn(`[marking] post-marking error suppressed for ${paperId} — status already "${current.markingStatus}":`, err);
      return;
    }
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

LATEX MATH: stems and expected answers may contain LaTeX inline math wrapped in single dollar signs, e.g. '$4\\frac{5}{6}$', '$\\frac{29}{6}$'. Treat these semantically — '$4\\frac{5}{6}$' IS the mixed number 4 5/6, '$\\frac{29}{6}$' IS twenty-nine over six. A student who writes "4 5/6" or "29/6" in plain text is giving the same answer; mark accordingly. In YOUR feedback text, write fractions in the SAME LaTeX form (e.g. '$\\frac{5}{6}$' or '$4\\frac{5}{6}$') — the parent UI renders them as proper stacked fractions. Do NOT write bare '4 5/6' or '\\frac{5}{6}' without the surrounding '$' delimiters; either causes the parent to see raw text instead of a rendered fraction.

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

CONTEXT-FROM-STEM RULE (Science OEQ — applies before any deduction):
The question stem (text + image) is provided to you. Anything the stem ALREADY ESTABLISHES — named objects, scope ("two plants", "both balls"), the experimental setup, observable givens ("water level X after plasticine is added") — is CONTEXT, not something the student must re-state to score.

The marking point is the NEW assertion / inference the student must produce. Do NOT deduct for missing words that the stem already gave.

Examples:
- Stem: "The diagram shows two plants." Key: "Part X of both plants absorbs water and mineral salts." Student: "Part X absorbs water and mineral salts." → "both plants" is established scope. Award full credit; the student's statement applies to the same Part X already named.
- Stem names a beaker / a circuit / "the boy" → student answers without re-naming it → do NOT deduct for the missing noun; the referent is unambiguous.
- Stem describes an observable setup ("X shows the water level after plasticine is added"). Key: "The water level dropped." → "water level" is stem context; the INFERENCE the student must produce is "dropped / decreased". If the student concludes the level dropped (in any wording), award the point. Only deduct if the student's reasoning never addresses the level's change. Frame any deduction as "the level-change inference was missing", NOT "did not say water level".

Default: when borderline between stem-context and new-inference, lean ACCEPT. Penalising students for omitting words the question already gave them is a common false-positive — avoid it.

Instructions:
1. FIRST — Read the student's blue-ink handwritten answer from Image 2. Write down EXACTLY what you see. Do NOT look at the expected answer yet.
2. If the question has multiple sub-parts labelled (a), (b), (c) etc., you MUST mark EACH sub-part separately. The expected answer may contain all parts on one line (e.g. "(a) 12 cm (b) 25 cm") or separated — extract each sub-part from it. For every labelled sub-part in the question, give a separate award and note. If the expected answer only lists one sub-part, still report on the other sub-parts as "(x) no answer key provided" and award them 0 — never skip them silently. Split the total marks across sub-parts as fairly as possible.
3. NOW compare the student's FINAL ANSWER against the expected answer:
   Expected answer: {EXPECTED_ANSWER}
   - If the final answer is correct → award FULL MARKS immediately. Do NOT check or penalise working steps. Working does not matter when the final answer is right.
   - ONLY if the final answer is WRONG or absent: check working/steps for partial credit → award PARTIAL marks if some steps are correct.
   - If wrong with no correct working → ZERO marks.
   - For MCQ (single option answer): no partial marks.

   ⚠️ WRONG-ANSWER CAP (NON-NEGOTIABLE — for Math OEQ only):
   A wrong final answer can NEVER receive FULL marks. The cap is (marksAvailable − 1). Within the cap, USE JUDGMENT about how much of the solving was correct:
     - 2-mark question wrong → 0 / 1; MAX 1
     - 3-mark question wrong → 0 / 1 / 2; MAX 2 (1 if early misstep; 2 if only the last step or a small slip is wrong)
     - 4-mark question wrong → 0 / 1 / 2 / 3; MAX 3
     - 5-mark question wrong → 0 / 1 / 2 / 3 / 4; MAX 4
   PSLE math marking always reserves at least 1 "answer mark" for the correct final answer. Without it, full marks are impossible. Within the remaining marks, partial credit scales with how much of the working is correct. State which steps you credited in your notes.
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
  // Chinese sections route through the same markQuizPaper unified
  // pipeline (the typed-section + AI-OEQ paths inside that function
  // recognise Chinese topics separately). Kept as a separate guard
  // so the English branch is untouched.
  const hasChineseSections = !!(paperKind?.metadata as { chineseSections?: unknown } | null)?.chineseSections;
  if (hasEnglishSections || hasChineseSections) {
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

    // Mark all OEQs in parallel — Gemini calls are the bottleneck, so
    // running them concurrently roughly N×s the throughput. The shared
    // `updates` array and `totalAwarded` counter are mutated from
    // concurrent contexts, which is safe in JS (single-threaded array
    // push + numeric add). `continue` inside the loop body becomes
    // `return` from the async IIFE.
    await Promise.all(oeqQuestions.map((q, i) => (async () => {
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
          return;
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
        return;
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
    })()));

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
    const current = await prisma.examPaper.findUnique({
      where: { id: paperId }, select: { markingStatus: true },
    });
    if (current?.markingStatus === "complete" || current?.markingStatus === "released") {
      console.warn(`[focused-marking] post-marking error suppressed for ${paperId} — status already "${current.markingStatus}":`, err);
      return;
    }
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
  await withMarkRetry("quiz-marking", paperId, () => _markQuizPaperOnce(paperId));
  try {
    await reconcileMcqMarks(paperId);
  } catch (err) {
    console.warn(`[quiz-marking] reconcile pass failed for ${paperId}:`, err);
  }
}

async function _markQuizPaperOnce(paperId: string): Promise<void> {
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

      // For each unique (examPaperId, baseNum), fetch all siblings once.
      //
      // "Sibling" = a master row that is part of the SAME logical
      // question as the source row, i.e. its questionNum is either
      // exactly the base number OR the base followed by only letters
      // (e.g. base "4" matches "4", "4abc", "4d", "4d(i)"). This
      // lets us merge split rows like Q4abc + Q4d into one combined
      // answer/subparts payload for the clone.
      //
      // Anchored exact-match in JS: a previous Prisma `startsWith: base`
      // query was matching numeric prefixes too — for base "1" it
      // pulled Q1 PLUS Q10, Q11, Q12, Q13, Q14a, Q14b, Q15, Q16, Q17,
      // Q18, and the rebuild loop merged all their (a)/(b)/(c) part
      // answers into the clone Q1 row (cross-contamination).
      type Sib = { questionNum: string; answer: string | null; answerImageData: string | null; transcribedSubparts: Prisma.JsonValue; transcribedStem: string | null };
      const siblingCache = new Map<string, Array<Sib>>();
      const baseNumOf = (n: string) => n.replace(/[a-zA-Z()]+$/, "");
      const isSiblingNum = (qn: string, base: string) => {
        if (!qn.startsWith(base)) return false;
        const tail = qn.slice(base.length);
        // Tail must be empty, OR letters-only, OR letters+parenthesised
        // suffix like "d(i)". No leading digit — that's a different
        // question entirely.
        return /^[a-zA-Z()]*$/.test(tail);
      };
      const uniqueKeys = new Set<string>();
      for (const sq of sourceQuestions) uniqueKeys.add(`${sq.examPaperId}::${baseNumOf(sq.questionNum)}`);
      for (const key of uniqueKeys) {
        const [examPaperId, base] = key.split("::");
        const candidates = await prisma.examQuestion.findMany({
          where: { examPaperId, questionNum: { startsWith: base } },
          select: { questionNum: true, answer: true, answerImageData: true, transcribedSubparts: true, transcribedStem: true },
        });
        const sibs = candidates.filter((c) => isSiblingNum(c.questionNum, base));
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
    type SecMeta = { label: string; startIndex: number; endIndex: number; passage?: string };
    const meta = paper.metadata as { englishSections?: SecMeta[]; chineseSections?: SecMeta[] } | null;
    // English typed sections — UNCHANGED.
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
    // Chinese typed sections — separate branch. 完成对话 uses a
    // single-label answer like English grammar cloze. The MCQ
    // sections (短文填空 / 阅读理解 MCQ / Visual Text MCQ) are NOT
    // "typed" here — they go through the standard MCQ marking path.
    if (meta?.chineseSections) {
      for (const sec of meta.chineseSections) {
        if (sec.label.includes("完成对话") || sec.label.includes("对话填空")) {
          for (let i = sec.startIndex; i <= sec.endIndex && i < paper.questions.length; i++) {
            typedSectionQIds.add(paper.questions[i].id);
          }
        }
      }
    }

    // Separate MCQ (has options) and OEQ (need AI marking).
    // Use options-based classification (same as quiz page) — NOT answer format.
    // Must recognise ALL THREE option shapes (text / image / table); without the
    // optionTable branch, a science table-MCQ was getting filed into oeqQuestions
    // and shifting every downstream OEQ's page-index by +1. Symptom: Q9's
    // detected text was actually Q11's canvas content because Q9's marker pulled
    // page_${i} at a higher i than the quiz had saved it at.
    const hasOpts = (q: typeof paper.questions[0]) => {
      const opts = q.transcribedOptions as unknown[] | null;
      const imgs = q.transcribedOptionImages as unknown[] | null;
      const tbl = (q as { transcribedOptionTable?: { rows?: unknown } | null }).transcribedOptionTable;
      if (Array.isArray(opts) && opts.length === 4) return true;
      if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
      if (tbl && Array.isArray(tbl.rows) && (tbl.rows as unknown[]).length === 4) return true;
      return false;
    };
    const mcqQuestions = paper.questions.filter(q => hasOpts(q) || typedSectionQIds.has(q.id));
    const oeqQuestions = paper.questions.filter(q => !hasOpts(q) && !typedSectionQIds.has(q.id) && q.studentAnswer !== "__SKIPPED__");
    // TEMPORARY classification trace — find why digital MCQs are
    // landing in the OEQ bucket and getting overwritten.
    for (const q of paper.questions) {
      const bucket = mcqQuestions.includes(q) ? (typedSectionQIds.has(q.id) ? "TYPED" : "MCQ")
        : oeqQuestions.includes(q) ? "OEQ"
        : "SKIPPED";
      console.log(`[quiz-marking] CLASSIFY Q${q.questionNum}: bucket=${bucket} hasOpts=${hasOpts(q)} typedSection=${typedSectionQIds.has(q.id)} studentAnswer=${JSON.stringify(q.studentAnswer)} marksAwarded=${q.marksAwarded} answerKey=${JSON.stringify((q.answer ?? "").slice(0, 50))}`);
    }

    // English-only typed OEQ sections (synthesis, comprehension OEQ) — these store the
    // student's answer as typed text in studentAnswer. All other OEQ questions (math,
    // science, English written) use the canvas image on disk, regardless of what
    // studentAnswer currently contains (may be a stale "No answer detected" from a
    // previous marking run).
    const aiTypedOeqQIds = new Set<string>();
    // English AI-marked sections — UNCHANGED.
    if (meta?.englishSections) {
      for (const sec of meta.englishSections) {
        const label = sec.label.toLowerCase();
        const isAiTyped = label.includes("synthesis") || isCompOeqLabel(label);
        if (isAiTyped) {
          for (let i = sec.startIndex; i <= sec.endIndex && i < paper.questions.length; i++) {
            aiTypedOeqQIds.add(paper.questions[i].id);
          }
        }
      }
    }
    // Chinese AI-marked sections — separate branch. Any 阅读理解
    // section can carry OEQ questions: 阅读理解 OEQ on its own,
    // 阅读理解A (merged Q30-32 MCQ + Q33 OEQ on shared passage —
    // route the OEQ portion through AI marking) and 阅读理解B (all
    // OEQ). For every question inside a 阅读理解 section, mark it
    // AI-typed when it has no MCQ options.
    if (meta?.chineseSections) {
      for (const sec of meta.chineseSections) {
        if (!sec.label.includes("阅读理解")) continue;
        for (let i = sec.startIndex; i <= sec.endIndex && i < paper.questions.length; i++) {
          const q = paper.questions[i];
          if (hasOpts(q)) continue;
          aiTypedOeqQIds.add(q.id);
        }
      }
    }

    // Re-score MCQ questions (in case answer keys changed). Always
    // writes back to the DB even when computed marks happen to
    // match the stored value — the markingNotes line is the
    // forensic trail. We saw a paper land in the DB with
    // markingStatus="complete" + null markingNotes + wrong marks,
    // which the previous "skip if marks unchanged" guard couldn't
    // self-heal because the student's answer happened to match
    // the answer key as it stood at re-score time. Always-write
    // makes the marks tabulation deterministic on every run, and
    // auditors can grep for any MCQ row missing markingNotes to
    // find papers that never went through this path.
    const rescoreUpdates: ReturnType<typeof prisma.examQuestion.update>[] = [];
    for (const q of paper.questions.filter(q2 => hasOpts(q2))) {
      const studentAns = (q.studentAnswer ?? "").trim().replace(/[().]/g, "").trim();
      // Strip the "(N) | explanation" suffix BEFORE comparing — without
      // this, an answer key like "(3) | working notes" normalises to
      // "3 | working notes" which never matches the student's clean "3"
      // and the re-score overrides marksAwarded=2 with 0. Same bug class
      // we keep finding; the head split has to happen at every MCQ
      // comparison site.
      const correctHead = ((q.answer ?? "").split("|")[0] ?? "").trim();
      const correctAns = correctHead.replace(/[().]/g, "").trim();
      const acceptableAnswers = correctAns.split(/\s+or\s+/i).map(p => p.trim());
      const isCorrect = studentAns !== "" && acceptableAnswers.includes(studentAns);
      const marks = isCorrect ? (q.marksAvailable ?? 1) : 0;
      const notes = q.studentAnswer == null || q.studentAnswer === "__SKIPPED__"
        ? "Skipped"
        : isCorrect
          ? "Correct"
          : `Student: (${studentAns}), Correct: (${correctAns})`;
      rescoreUpdates.push(prisma.examQuestion.update({
        where: { id: q.id },
        data: { marksAwarded: marks, markingNotes: notes },
      }));
      q.marksAwarded = marks;
    }
    if (rescoreUpdates.length > 0) await prisma.$transaction(rescoreUpdates);

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
      // Treat 完成对话 the same as English grammar cloze — both use a
      // word-bank cloze with a single-label answer.
      const isChineseDialogueCloze = (q.syllabusTopic ?? "").includes("完成对话") || (q.syllabusTopic ?? "").includes("对话填空");
      const isGrammarClozeQ = (qTopicLower.includes("grammar") && qTopicLower.includes("cloze")) || isChineseDialogueCloze;
      const studentAnsRaw = stripQuotes((q.studentAnswer ?? "").trim());
      const rawCorrect = stripQuotes(q.answer ?? "");
      let isCorrect = false;
      let acceptableAnswers: string[] = [];
      if (isGrammarClozeQ) {
        // Grammar / dialogue cloze answer keys can be:
        // 1. Single letters from a word bank ("H", "K or P", "L/P")
        //    — English Grammar Cloze (A-Q).
        // 2. Single digits from a word bank ("3", "5/7", "1 or 2")
        //    — Chinese 完成对话 (1-8 numbered phrases).
        // 3. Actual words ("helps", "repairs", "谢谢您") — match raw
        //    text case-insensitively.
        // Try letters first (English path) ONLY when this isn't a
        // Chinese dialogue cloze, so a Chinese answer "2" / "5" goes
        // straight to the digit branch instead of being misread.
        const letterMatches = !isChineseDialogueCloze ? (rawCorrect.match(/\b[A-Za-z]\b/g) ?? []) : [];
        const isLetterKey = letterMatches.length > 0 && letterMatches.every(l => l.length === 1)
          && rawCorrect.replace(/[A-Za-z\s/,|.()or]+/gi, "").trim() === "";
        const digitMatches = rawCorrect.match(/\b[1-9]\b/g) ?? [];
        const isDigitKey = isChineseDialogueCloze && digitMatches.length > 0
          && rawCorrect.replace(/[\d\s/,|.()或]+/g, "").trim() === "";
        if (isLetterKey) {
          const letters = new Set(letterMatches.map(l => l.toUpperCase()));
          const studentLetter = (studentAnsRaw.toUpperCase().match(/\b[A-Z]\b/) ?? [""])[0];
          isCorrect = !!studentLetter && letters.has(studentLetter);
          acceptableAnswers = [...letters];
        } else if (isDigitKey) {
          const digits = new Set(digitMatches);
          const studentDigit = (studentAnsRaw.match(/\b[1-9]\b/) ?? [""])[0];
          isCorrect = !!studentDigit && digits.has(studentDigit);
          acceptableAnswers = [...digits];
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

    const updates: ReturnType<typeof prisma.examQuestion.update>[] = [];
    let totalAwarded = mcqQuestions.reduce((sum, q) => sum + (q.marksAwarded ?? 0), 0);

    // ── MCQ scanned-back detection ──────────────────────────────
    // In-app MCQs already have studentAnswer set (parent/student
    // tapped a choice button), so their marksAwarded is computed
    // by the typed-section / direct-compare flow above. Scanned-back
    // printables don't go through that path — the answer letter is
    // handwritten on the "Answer: ___" line in the printable PDF,
    // so we have to OCR it off the scan. Only does work for MCQs
    // that (a) have printableBounds (= came from a printable scan)
    // AND (b) still have no studentAnswer.
    const scannedMcqs = mcqQuestions.filter(q => {
      if (typedSectionQIds.has(q.id)) return false; // typed section already handled
      if (!hasOpts(q)) return false; // not a true MCQ
      if (q.studentAnswer && q.studentAnswer.trim() !== "") return false;
      const b = q.printableBounds as PrintableBounds | null | undefined;
      return !!b && Number.isFinite(b.pageIndex);
    });
    if (scannedMcqs.length > 0) {
      console.log(`[quiz-marking] Scanned MCQ detection: ${scannedMcqs.length} questions`);
      const subDir = path.join(SUBMISSIONS_DIR, paperId);
      await Promise.all(scannedMcqs.map(async (q) => {
        const bounds = q.printableBounds as PrintableBounds;
        const pagePath = path.join(subDir, `page_${bounds.pageIndex + 1}.jpg`);
        try {
          const pageBuffer = await fs.readFile(pagePath);
          // Two-tier crop. Most digits fit in the tight crop; tall
          // handwriting or digits drifting above the underscore need
          // the wider second pass. We also persist each crop to
          // disk so it can be inspected after a misdetection — see
          // the printableMcqCrop branch in /api/exam/[id]/submission.
          const sharp = (await import("sharp")).default;
          async function cropMcqStrip(yAbove: number, yBelow: number, xFromRight: number, tag: string): Promise<{ base64: string; bytes: Buffer }> {
            const padded = {
              pageIndex: bounds.pageIndex,
              yStartPct: Math.max(0, bounds.yStartPct - yAbove),
              yEndPct: Math.min(100, bounds.yEndPct + yBelow),
            };
            const yCropped = await cropPageByBounds(pageBuffer, padded, padded.pageIndex);
            const meta = await sharp(yCropped).metadata();
            let bytes: Buffer = yCropped;
            if (meta.width && meta.height) {
              const left = Math.floor(meta.width * (1 - xFromRight));
              bytes = await sharp(yCropped)
                .extract({ left, top: 0, width: meta.width - left, height: meta.height })
                .jpeg({ quality: 88 })
                .toBuffer();
            }
            try {
              await fs.writeFile(path.join(subDir, `mcq_q${q.questionNum}_${tag}.jpg`), bytes);
            } catch { /* best-effort; debug file only */ }
            return { base64: bytes.toString("base64"), bytes };
          }
          // First pass: 10% above the Answer line, 3% below,
          // rightmost 45% of page width. Catches the common case.
          const pass1 = await cropMcqStrip(10, 3, 0.45, "pass1");
          let raw = await detectPrintableMcqAnswer(pass1.base64, q, `scan Q${q.questionNum}`, false);
          // Retry on null with a much wider crop AND a stronger
          // model + plain-OCR prompt — handles both "we missed
          // the digit because the crop was too tight" and "the
          // crop was fine but Flash got hedgy" cases.
          if (!raw) {
            console.log(`[quiz-marking] Scanned MCQ Q${q.questionNum}: first pass null — retrying with wider crop + plain-OCR prompt`);
            const pass2 = await cropMcqStrip(18, 4, 0.55, "pass2");
            raw = await detectPrintableMcqAnswer(pass2.base64, q, `scan Q${q.questionNum} retry`, true);
          }
          const student = normalizeMcq(raw ?? "");
          const expected = normalizeMcq(q.answer ?? "");
          const match = !!student && !!expected && student === expected;
          const awarded = match ? (q.marksAvailable ?? 1) : 0;
          totalAwarded += awarded;
          console.log(`[quiz-marking] Scanned MCQ Q${q.questionNum}: detected="${raw}" expected="${q.answer}" → ${awarded}/${q.marksAvailable ?? 1}`);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: {
                studentAnswer: raw ?? "",
                marksAwarded: awarded,
                markingNotes: raw
                  ? (match ? "Correct" : `"${raw}" is incorrect. Correct answer: "${q.answer ?? ""}"`)
                  : "No answer detected",
              },
            }),
          );
        } catch (err) {
          console.warn(`[quiz-marking] Scanned MCQ Q${q.questionNum} read/detect failed:`, err);
        }
      }));
    }

    if (oeqQuestions.length > 0) {
      const subDir = path.join(SUBMISSIONS_DIR, paperId);
      const ai = getAI();

      // Same parallel pattern as the focused-test OEQ loop above.
      // updates.push and totalAwarded mutations remain safe because JS
      // is single-threaded; `continue` becomes `return` from the IIFE.
      await Promise.all(oeqQuestions.map((q, i) => (async () => {
        const marksAvailable = q.marksAvailable ?? 1;

        // Which on-disk scan file corresponds to this question?
        //
        // - In-app canvas papers: each question writes on its own
        //   canvas, saved as page_${qIndex}.jpg. The fallback below
        //   (`i`, the OEQ array index) preserves that legacy path.
        //
        // - Scanned-back printables: each scan page holds MANY
        //   questions. The page index lives in printableBounds.
        //   The parent is told to scan EVERY page (cover included)
        //   so scan page_0.jpg is the cover and the first question
        //   page is page_1.jpg — hence the +1 offset.
        const scanPageIdx = (() => {
          const bounds = q.printableBounds as PrintableBounds | null | undefined;
          return bounds && Number.isFinite(bounds.pageIndex) ? bounds.pageIndex + 1 : i;
        })();

        // Build the expected-answer text. If subparts carry per-part answers
        // (from the merge/sync rebuild), format as a clear per-part breakdown
        // so the AI marks each part against its own answer key.
        type Subpart = { label: string; text: string; answer?: string | null };
        const subsForAns = (q.transcribedSubparts as Subpart[] | null) ?? null;
        const realSubsForAns = (subsForAns ?? []).filter(s => !s.label.startsWith("_"));
        const hasPerPartAnswers = realSubsForAns.some(sp => sp.answer);

        // Inline parser: pull each labelled part out of a single
        // answer string. Catches the "answer key only mentions (c)"
        // case that breaks q.answer matching (e.g. focused-practice
        // questions whose source answer was only partially extracted).
        const parseAnswerByPart = (answer: string, labels: string[]): Map<string, string> => {
          const out = new Map<string, string>();
          const found: { label: string; matchStart: number; sliceFrom: number }[] = [];
          for (const label of labels) {
            const lower = label.toLowerCase();
            // Match "(c)", "c)", or "c:" (in any case) at a word
            // boundary. Avoid matching letters embedded in words.
            const re = new RegExp(`(?:^|[\\s|.,;])\\(?${lower}[\\):\\s]`, "i");
            const m = answer.match(re);
            if (m && m.index !== undefined) {
              found.push({
                label: lower,
                matchStart: m.index,
                sliceFrom: m.index + m[0].length,
              });
            }
          }
          if (found.length === 0) return out;
          found.sort((a, b) => a.matchStart - b.matchStart);
          for (let i = 0; i < found.length; i++) {
            const end = i + 1 < found.length ? found[i + 1].matchStart : answer.length;
            out.set(found[i].label, answer.slice(found[i].sliceFrom, end).trim());
          }
          return out;
        };

        // Per-part marks cap: parse "[N marks]" / "[N]" suffix from
        // each subpart's text. Used to tell the marker the maximum
        // marks per part, and to clamp the AI's per-part awards
        // downstream so a 3-mark subpart can't be awarded 4.
        const partMaxMarks = new Map<string, number>();
        let partMaxTotal = 0;
        for (const sp of realSubsForAns) {
          const m = String(sp.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
          if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) {
              partMaxMarks.set(sp.label.toLowerCase(), n);
              partMaxTotal += n;
            }
          }
        }
        // Even-distribution default: if NO per-part marks were parsed
        // but the total marksAvailable divides cleanly across the
        // subparts (e.g. 2 marks ÷ 2 subparts = 1 each, 3 ÷ 3 = 1,
        // 4 ÷ 2 = 2), assume that split. Caps the AI's per-part
        // awards even when the printed paper omits the per-part marks.
        if (partMaxMarks.size === 0 && realSubsForAns.length > 0 && marksAvailable > 0) {
          const perPart = marksAvailable / realSubsForAns.length;
          if (Number.isInteger(perPart) && perPart > 0) {
            for (const sp of realSubsForAns) {
              partMaxMarks.set(sp.label.toLowerCase(), perPart);
              partMaxTotal += perPart;
            }
            console.log(`[quiz-marking] Q${q.questionNum}: no per-part marks in paper, inferring ${perPart} mark/part across ${realSubsForAns.length} subparts (total ${marksAvailable})`);
          }
        }
        const hasFullPartMaxes = partMaxMarks.size === realSubsForAns.length && realSubsForAns.length > 0;
        const partMaxNote = hasFullPartMaxes ? `\n\nMARKS PER PART (HARD CAPS):\n${realSubsForAns.map(sp => `Part (${sp.label}): max ${partMaxMarks.get(sp.label.toLowerCase())} mark(s)`).join("\n")}\nDo NOT award more than the cap for any part. The total of all parts must not exceed the marks available for the question.` : "";

        let expectedAnswer: string;
        if (hasPerPartAnswers) {
          expectedAnswer = realSubsForAns
            .map(sp => `Part (${sp.label}): ${sp.answer ?? "(no answer key — apply AI judgment per the ANSWER-KEY GAPS rule)"}`)
            .join("\n");
        } else if (realSubsForAns.length > 1 && q.answer) {
          // Try to split q.answer across the subpart labels. Some
          // master papers' answer fields only mention a subset of
          // parts (e.g. only "(c) …" when the question has a, b, c).
          // Fanning out keeps the AI honest: it sees explicit gaps
          // rather than assuming the single line covers everything.
          const labels = realSubsForAns.map(s => s.label.toLowerCase());
          const parsed = parseAnswerByPart(q.answer, labels);
          if (parsed.size > 0 && parsed.size < labels.length) {
            expectedAnswer = labels
              .map(l => `Part (${l}): ${parsed.get(l) ?? "(no answer key — apply AI judgment per the ANSWER-KEY GAPS rule)"}`)
              .join("\n");
          } else {
            expectedAnswer = q.answer;
          }
        } else {
          expectedAnswer = q.answer || "(no answer key — apply AI judgment per the ANSWER-KEY GAPS rule)";
        }

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

        // For typed-OEQ sections (synthesis, comprehension OEQ in English),
        // an empty studentAnswer means the student left the question blank.
        // Award 0 immediately and skip the AI call — otherwise the marker
        // gets a near-empty prompt with the expected answer and sometimes
        // hallucinates a matching student response.
        if (aiTypedOeqQIds.has(q.id)) {
          const raw = (q.studentAnswer ?? "").trim();
          let isBlankTyped = !raw;
          if (raw && !raw.startsWith("data:")) {
            // JSON-shaped answer (table cells / textarea + ticks). Considered
            // blank when no _text and no non-empty cell or tick value.
            if (raw.startsWith("{")) {
              try {
                const parsed = JSON.parse(raw) as Record<string, string>;
                const txt = (parsed._text ?? "").trim();
                const hasCell = Object.entries(parsed).some(([k, v]) => k !== "_text" && typeof v === "string" && v.trim().length > 0 && v.trim() !== "false");
                if (!txt && !hasCell) isBlankTyped = true;
              } catch { /* keep as non-blank fallback */ }
            }
          }
          if (isBlankTyped) {
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: 0, studentAnswer: null, markingNotes: "No answer provided." },
              })
            );
            console.log(`[quiz-marking] Typed Q${q.questionNum}: blank submission → 0/${marksAvailable}`);
            return;
          }
        }

        // CHINESE 阅读理解 OEQ canvas marking — Chinese-only branch.
        // The student's answer is the 田字格 handwriting canvas saved
        // as a data:image/png URL on studentAnswer. The regular OEQ
        // canvas flow (further down) reads scanned page_<i>.jpg files
        // from disk — there's nothing on disk for Chinese OEQ, so it
        // returned "No answer detected". Intercept here and ask the
        // AI to read the canvas image directly, with feedback in 中文.
        if (
          aiTypedOeqQIds.has(q.id) &&
          q.studentAnswer &&
          q.studentAnswer.startsWith("data:image") &&
          (paper.subject ?? "").toLowerCase().includes("chinese")
        ) {
          const expectedAnswer = q.answer ?? "";
          const marksAvailable = q.marksAvailable ?? 1;
          const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
          const sepIdx = q.studentAnswer.indexOf(";base64,");
          if (sepIdx > 0) {
            parts.push({ inlineData: { mimeType: q.studentAnswer.slice(5, sepIdx), data: q.studentAnswer.slice(sepIdx + 8) } });
          }
          // For long OEQ (Q33 style — 4 marks), the printed paper
          // often ends the question stem with the FIRST line of the
          // sample answer (e.g. "小文，" or "亲爱的小文，") so the
          // student continues from there. The handwritten canvas is
          // the rest of the message. Stitch them together so the
          // marker sees the FULL message (intro + student writing)
          // when judging content phrases. Pull the trailing intro
          // sentence (the line after a "请你写一段话…" type prompt)
          // and surface it explicitly in the prompt.
          const stemText = (q.transcribedStem ?? "").replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();
          const stemLines = stemText.split(/\n+/).map(s => s.trim()).filter(Boolean);
          const lastLine = stemLines[stemLines.length - 1] ?? "";
          // Heuristic: if the last line looks like a salutation /
          // intro (very short, ends with 「，」 or「：」 or has a
          // person name followed by ","), treat it as the intro the
          // student continues from. Otherwise leave blank.
          const looksLikeIntro = lastLine.length > 0 && lastLine.length <= 25 &&
            (/[，：,:]$/.test(lastLine) || /^(亲爱的|敬爱的|致|.{1,8})$/.test(lastLine));
          const introNote = looksLikeIntro
            ? `\n附注: 题目的最后一句 "${lastLine}" 是范文的开头 (例如：开头的称呼)，学生在田字格里写的是这句之后的内容。批改时请把 "${lastLine}" 当作答案的第一句，与学生手写的内容拼接起来再对照参考答案。`
            : "";

          parts.push({
            text: `你正在批改新加坡小六会考(PSLE)华文阅读理解开放式问答题。

学生的答案是写在田字格上的手写汉字 (蓝色墨水，每个汉字占一个格子)。仔细辨认每一个字。

题目:
${stemText}${introNote}

参考答案 (可能包含 (0.5) 等评分要点标注):
${expectedAnswer}

总分: ${marksAvailable}

批改要求:
- 仔细辨认学生写的汉字，逐字读出后再判断答案是否正确。
- 如果参考答案里出现 (0.5)、(1) 等数字标注，那是评分细则：每个标注代表一个内容要点的分值。逐一检查学生答案是否覆盖该要点 (同义、改写都算)，每命中一个就加上该分值。
- 长 OEQ (满分 4 分) 的典型结构: 内容 2 分 (通常是 4 × 0.5)、语文运用 2 分。语文运用从满分开始，每出现一处明显的语病、错别字、标点错误、句子不通顺，就扣 0.5，直到扣完为止。
- 较短的 OEQ (满分 1-3 分) 按内容要点累计即可，没有单独的语文分。
- 错别字: 每个错别字扣 0.5 分 (在语文分里扣)，简繁体差异不扣。
- 答案为空白或仅有少量无意义涂鸦时给 0 分。
- 最终分数按 0.5 取整，范围 [0, ${marksAvailable}]。
- 反馈 (feedback) 必须用简体中文写，简洁清晰，列出命中的要点和扣分原因，最多两句。
- detectedAnswer 字段必须输出 "完整的范文" — 即题目最后一句的开头 (如有) 加上学生在田字格里写的全部内容，让阅卷者一眼看清整段答案。

请返回 JSON:
{"questions": [{"questionId": "${q.id}", "marksAwarded": <number>, "marksAvailable": ${marksAvailable}, "detectedAnswer": "<完整答案：开头 + 学生手写>", "feedback": "<中文反馈>"}]}`,
          });
          try {
            const response = await withTimeout(
              ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `quiz-chinese-canvas-Q${q.questionNum}`,
            );
            const parsed = extractJson(response.text ?? "") as { questions?: Array<{ marksAwarded?: number; feedback?: string; detectedAnswer?: string }> };
            const result = parsed.questions?.[0] ?? {};
            const awarded = Math.min(Math.max(0, Number(result.marksAwarded) || 0), marksAvailable);
            const notes = (result.feedback ?? "").trim();
            const detected = (result.detectedAnswer ?? "").trim();
            const notesWithDetected = `检测到答案: ${detected || "无"}${notes ? ` | ${notes}` : ""}`;
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: awarded, markingNotes: notesWithDetected },
              }),
            );
            totalAwarded += awarded;
            console.log(`[quiz-marking] Chinese canvas Q${q.questionNum}: ${awarded}/${marksAvailable} — ${detected}`);
          } catch (err) {
            console.error(`[quiz-marking] Chinese canvas Q${q.questionNum} marking failed:`, err);
            updates.push(
              prisma.examQuestion.update({
                where: { id: q.id },
                data: { marksAwarded: 0, markingNotes: "批改失败" },
              }),
            );
          }
          return;
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
                // Map tick indices to the checkbox labels from the
                // stem. The renderer also handles INLINE multi-tick
                // lines ("intro [ ] A [ ] B [ ] C [ ] D"), so we
                // mirror that here: walk every line, collect each [ ]
                // hit in order, and the label is the text following
                // that hit (up to the next [ ] on the same line, or
                // end of line). Without this, multi-tick stems like
                // Q73/Q79 collapse to "option 1 / option 2" and the
                // AI can't tell ticked-correct from ticked-wrong.
                const stemLines = (q.transcribedStem ?? "").split("\n");
                const checkboxLabels: string[] = [];
                const tickGlobalRe = /\[[ x✓✗]\]/gi;
                for (const line of stemLines) {
                  const trimmed = line.trim();
                  const hits = [...trimmed.matchAll(tickGlobalRe)];
                  if (hits.length === 0) continue;
                  if (hits.length === 1) {
                    // Single-tick: support both [ ] before AND [ ] at end of line.
                    const startMatch = trimmed.match(/^\[[ x✓✗]\]\s*(.*)/i);
                    const endMatch = !startMatch ? trimmed.match(/^(.*?)\s*\[[ x✓✗]\]\s*$/i) : null;
                    if (startMatch) checkboxLabels.push(startMatch[1].trim());
                    else if (endMatch) checkboxLabels.push(endMatch[1].trim());
                    continue;
                  }
                  // Multi-tick inline: label is the text after each hit,
                  // up to the next hit (or end-of-line).
                  for (let h = 0; h < hits.length; h++) {
                    const start = hits[h].index! + hits[h][0].length;
                    const end = h + 1 < hits.length ? hits[h + 1].index! : trimmed.length;
                    checkboxLabels.push(trimmed.slice(start, end).trim());
                  }
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
                // Single-input synthesis. Pull any text that sits before
                // the keyword on the answer-template line so the marker
                // sees the full reconstructed sentence. Critically, only
                // prepend the parts the student DIDN'T already type
                // — otherwise an over-eager student who typed the full
                // sentence ("Jane would rather complete her work …")
                // ends up with the prefix duplicated:
                //   "Jane would rather Jane would rather complete her work …"
                const stemLines = q.transcribedStem.split("\n");
                let leadingText = "";
                for (let i = stemLines.length - 1; i >= 0; i--) {
                  const m = stemLines[i].match(/^(.*?)\*\*[^*]+\*\*/);
                  if (m) { leadingText = m[1].trim(); break; }
                }
                const fullPrefix = [leadingText, keyword].filter(Boolean).join(" ");
                const stuRaw = q.studentAnswer.trim();
                const stuLower = stuRaw.toLowerCase();
                let core = stuRaw;
                let prependLeading = !!leadingText;
                let prependKeyword = true;
                if (fullPrefix && stuLower.startsWith(fullPrefix.toLowerCase())) {
                  core = stuRaw.slice(fullPrefix.length).trim();
                  prependLeading = false;
                  prependKeyword = false;
                } else if (stuLower.startsWith(keyword.toLowerCase())) {
                  core = stuRaw.slice(keyword.length).trim();
                  prependKeyword = false;
                }
                const segs = [
                  prependLeading ? leadingText : "",
                  prependKeyword ? keyword : "",
                  core,
                ].map(s => s.trim()).filter(Boolean);
                fullStudentAnswer = segs.join(" ").replace(/\s+/g, " ").trim();
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
          // For synthesis & transformation, omit the "Last character" priming
          // — punctuation is irrelevant for that section and surfacing the
          // last char makes the AI fixate on the missing period.
          const lastCharLine = isSynthesisQ ? "" : `\nLast character of answer: "${lastChar}"`;
          parts.push({ text: `Student's typed answer (the delimiters below are NOT part of the answer):\n---\n${displayAnswer}\n---${lastCharLine}${tickInfo}${isTableAnswer ? "\n(This is a TABLE answer — do NOT penalise for punctuation.)" : ""}${isSynthesisQ ? "\n(This is a SYNTHESIS & TRANSFORMATION answer — all-or-nothing marking. Ignore missing/extra periods AND missing/extra spaces between words; other punctuation must be correct.)" : ""}` });
          parts.push({
            text: `Expected answer: ${expectedAnswer}
Marks available: ${marksAvailable}

Mark this answer. Compare the student's typed answer against the expected answer.

SPELLING & GRAMMAR PENALTY: Deduct 0.5 marks ONLY for genuine spelling errors (misspelled words). Do NOT deduct for punctuation (periods, commas, apostrophes, capitalisation). Do NOT flag missing or extra periods — ignore all punctuation completely.

For Synthesis & Transformation: This is ALL-OR-NOTHING marking. Award FULL marks (${marksAvailable}) if every condition holds, otherwise award 0. NO partial credit, no half-marks.
- Award FULL marks ONLY when ALL of these are true:
  • The rewritten sentence is grammatically correct.
  • It uses the required keyword(s) in the correct form.
  • It conveys the same meaning as the expected answer (minor word-order differences, equivalent connectors, or synonyms that preserve meaning and register are OK).
  • There are NO spelling errors anywhere in the answer.
  • Punctuation is correct, EXCEPT a missing or extra full stop (period) is fine — ignore periods.
  • Missing or extra spaces between words are FINE — ignore spacing entirely. e.g. "Mary said,'I am tired.'" or "Mary said , 'I am tired.'" are both acceptable as long as the wording is correct.
  • All other punctuation (commas, apostrophes, semicolons, question marks, capitalisation of proper nouns and the first word) is correct.
- Award 0 marks if ANY of these are wrong:
  • Any spelling mistake → 0. (But missing/extra spaces are NOT a spelling mistake — ignore spacing.)
  • Any missing or wrong punctuation other than a period → 0.
  • Wrong tense / wrong form of keyword / subject-verb disagreement → 0.
  • Meaning changed from the expected answer → 0.
- Do NOT split the difference between 0 and full. The mark must be exactly 0 or exactly ${marksAvailable}.
For Comprehension OEQ: This tests READING COMPREHENSION. Be LENIENT on language, STRICT on content:
- Mark based on whether the answer shows understanding of the passage and addresses the question.
- The student's answer does NOT need to match the expected answer word-for-word. Accept any answer that conveys the same meaning or key idea.
- Do NOT penalise for missing articles (a, an, the), minor grammar differences, or rephrasing — as long as the meaning is correct.
- Do NOT penalise for capitalisation differences.
- Only deduct 0.5 for genuine spelling errors (misspelled words, not style differences).
- If the answer captures the key point but uses different words, award full marks.
- If the answer is in TABLE format, do NOT penalise for punctuation at all.

CHINESE 阅读理解 OEQ — PHRASE-BASED RUBRIC (applies when the answer key contains 中文 phrases separated by " | "):
- EACH " | "-separated phrase is a separate scoring point. Score each phrase independently against the student's answer.
- DEFAULT mark per phrase: marksAvailable / (number of phrases). E.g. 4-mark answer with 3 phrases tagged (2)/(1)/(1) → phrase 1 = 2 marks, phrase 2 = 1 mark, phrase 3 = 1 mark.
- ⭐ PARENTHETICAL POINT VALUES — when a phrase ends with a parenthesised mark allocation, that number is the EXPLICIT mark value for that point. Override the default. Sum of all such tags equals marksAvailable. Accept ALL of these styles as the same N-mark annotation: half-width "(N)" / "(N分)" e.g. "(0.5)" "(1分)", full-width "（N）" / "（N分）" e.g. "（0.5）" "（1 分）" "（0.5 分）". Strip whitespace and the literal character "分" before reading the number — a phrase tagged "（0.5 分）" is worth 0.5, same as "(0.5)".
- For each phrase, classify the student's coverage:
  · FULL coverage — the student captures BOTH the topic AND the substance (e.g. "聪明 又 注重家庭幸福" requires BOTH "clever" AND "treasures family happiness"). Synonyms / paraphrases accepted. → award N marks (the full value of that phrase).
  · PARTIAL coverage — the student mentions only PART of the phrase's idea (e.g. captures "聪明" but misses "注重家庭幸福"). → award N/2 rounded to the nearest 0.5. So a (2)-phrase partial = 1 mark; a (1)-phrase partial = 0.5; a (0.5)-phrase partial = 0.
  · MISSING — the student doesn't address this phrase at all. → 0 marks for this phrase.
- DO NOT round UP. A student who captures one half of a (2)-mark phrase gets 1 mark, NOT 2. Restraint here is the difference between a fair score and an inflated one.
- Sum the per-phrase marks. Clamp to [0, marksAvailable]. Spelling penalty (0.5 per misspelling) is applied LAST on top of the sum.
- Feedback style: just NAME the missing or partially captured idea(s) in 中文. Do NOT use "Phrase 1 / Phrase 2 / Phrase 3" labels. Do NOT walk through every phrase. Only call out what's missing or partial. Example for a student who captured "聪明" but missed "注重家庭幸福" and "相亲相爱": "学生只提到妈妈聪明,未提及她注重家庭幸福或希望全家人相亲相爱,扣 2 分。" — concise, names the missing ideas, states the deduction.

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
          return;
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
            const inkPath = path.join(subDir, `page_${scanPageIdx}_ink.png`);
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
            return;
          }
          console.log(`[quiz-marking] Drawable Q${q.questionNum}: ink detected — proceeding to mark`);
        }

        // For regular OEQ (non-drawable, non-subpart): blue ink pre-check using composite first.
        if (!hasDrawable && realSubs.length === 0) {
          let inkFound = true;
          try {
            const pagePath = path.join(subDir, `page_${scanPageIdx}.jpg`);
            const pageBuffer = await fs.readFile(pagePath);
            // For scanned-back printables, crop to the question's
            // writing area before the blue-ink check — otherwise we
            // catch ink from neighbouring questions on the same page.
            // Pad ±5% so the check captures writing that overflows
            // the printed box (last-line descenders, students who
            // wrote a little outside the lines). Without this Q10
            // and other bottom-page OEQs were getting marked
            // "BLANK" even when the marker's later detect step
            // would have found real working.
            const boundsRaw = (q.printableBounds as PrintableBounds | null | undefined) ?? null;
            const inkBounds = boundsRaw && Number.isFinite(boundsRaw.pageIndex) ? {
              ...boundsRaw,
              yStartPct: Math.max(0, boundsRaw.yStartPct - 5),
              yEndPct: Math.min(100, boundsRaw.yEndPct + 5),
            } : boundsRaw;
            const checkBuf: Buffer = inkBounds && Number.isFinite(inkBounds.pageIndex)
              ? await cropPageByBounds(pageBuffer, inkBounds, inkBounds.pageIndex)
              : pageBuffer;
            inkFound = await hasBlueInk(checkBuf.toString("base64"), `quiz-oeq-Q${q.questionNum}`, "image/jpeg");
          } catch {
            try {
              const inkPath = path.join(subDir, `page_${scanPageIdx}_ink.png`);
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
            return;
          }
        }

        // Try individual subpart images first — with per-subpart ink check
        const blankSubparts = new Set<string>();
        if (realSubs.length > 0) {
          for (const sp of realSubs) {
            // Check ink PNG for blank canvases using pixel check
            let spHasInk = true;
            const isSpDrawable = drawableSubLabels.has(sp.label.toLowerCase());
            try {
              const spInkPath = path.join(subDir, `page_${scanPageIdx}_${sp.label}_ink.png`);
              const spInkBuffer = await fs.readFile(spInkPath);
              spHasInk = hasOpaquePixels(spInkBuffer);
              // Only log HAS INK — the "all subparts blank" summary
              // below captures the all-empty case in one line.
              if (spHasInk) console.log(`[quiz-marking] Q${q.questionNum}(${sp.label}): ink pixel check → HAS INK (${spInkBuffer.length} bytes)`);
            } catch {
              // No per-subpart ink file. For DRAWABLE subparts (shade /
              // arrow / mark a printed diagram), treat missing-ink as
              // BLANK — the composite contains the printed diagram +
              // answer-image overlay, which the AI hallucinates as the
              // student having drawn the correct answer.
              //
              // For TEXT subparts the historical default was "assume
              // ink exists" (the AI reads handwriting off the composite
              // image). That path let blank canvases through to the AI,
              // which then hallucinated marks against printed stem text
              // rendered into the canvas — Q14 in cmpqa5voe... was a
              // real instance: the orphan "(c)" stem rendered onto a
              // blank canvas, AI awarded marks for a student who wrote
              // nothing. Safety net: if the WHOLE-question ink layer
              // exists and is pixel-level empty, no subpart can have
              // ink either, so treat the subpart as blank. Only default
              // to "assume yes" when there's no ink artefact at all on
              // disk (scanned-back printables, where the composite JPG
              // is the only source of truth).
              if (isSpDrawable) {
                spHasInk = false;
              } else {
                try {
                  const fullInkPath = path.join(subDir, `page_${scanPageIdx}_ink.png`);
                  const fullInkBuffer = await fs.readFile(fullInkPath);
                  const wholeHasInk = hasOpaquePixels(fullInkBuffer);
                  spHasInk = wholeHasInk;
                  if (!wholeHasInk) {
                    console.log(`[quiz-marking] Q${q.questionNum}(${sp.label}): no per-subpart ink file AND whole-canvas ink is pixel-empty → BLANK`);
                  }
                } catch {
                  // Truly no ink artefacts on disk (likely scanned-back
                  // printable) — defer to the AI by trusting the composite.
                  spHasInk = true;
                }
              }
            }
            if (!spHasInk) {
              blankSubparts.add(sp.label);
              parts.push({ text: `Student's handwritten answer for part (${sp.label}): [BLANK — no answer written]` });
              continue;
            }
            try {
              // For non-drawable (clean canvas text OEQs): prefer the
              // flattened ink PNG — the JPG render sometimes drops
              // strokes on quiz canvases.
              // For drawable (tick boxes / shade a printed diagram /
              // arrows on a chart): MUST use the original JPG so the
              // model sees the printed table/diagram alongside the
              // ink. Flattening to white loses the context the model
              // needs to say "row 2 column 3" — it would just see
              // floating ticks on a blank page.
              let spBuffer: Buffer;
              let spMime: "image/jpeg" | "image/png" = "image/jpeg";
              if (isSpDrawable) {
                const spPath = path.join(subDir, `page_${scanPageIdx}_${sp.label}.jpg`);
                spBuffer = await fs.readFile(spPath);
              } else {
                try {
                  const spInkPath = path.join(subDir, `page_${scanPageIdx}_${sp.label}_ink.png`);
                  const spInkBuf = await fs.readFile(spInkPath);
                  const flattened = await flattenInkOnWhite(spInkBuf, `Q${q.questionNum}(${sp.label})`);
                  spBuffer = flattened.buffer;
                  spMime = flattened.mimeType;
                } catch {
                  const spPath = path.join(subDir, `page_${scanPageIdx}_${sp.label}.jpg`);
                  spBuffer = await fs.readFile(spPath);
                }
              }
              const labelNote = isSpDrawable
                ? `Student's handwritten answer for part (${sp.label}) — THIS IS A DRAWING TASK (shading/arrows/marks on a diagram). Ink is confirmed present:`
                : `Student's handwritten answer for part (${sp.label}):`;
              parts.push({ text: labelNote });
              parts.push({ inlineData: { mimeType: spMime, data: spBuffer.toString("base64") } });
              hasSubmission = true;
            } catch {
              // No per-subpart canvas file. Try cropping the
              // composite page using printableBounds.subparts —
              // this is how scanned-back printables (no per-part
              // canvas) still get per-part images for the marker.
              const subBounds = (q.printableBounds as PrintableBounds | null | undefined)?.subparts?.[sp.label];
              if (subBounds) {
                try {
                  // Same +1 cover offset as scanPageIdx above —
                  // scan_page_0 is the cover, so a subpart whose
                  // bounds say pageIndex=0 actually lives in
                  // page_1.jpg on disk.
                  const pagePath = path.join(subDir, `page_${subBounds.pageIndex + 1}.jpg`);
                  const pageBuffer = await fs.readFile(pagePath);
                  // Pad ±3% so writing that overflows the printed
                  // sub-part box (common when the student writes
                  // bigger than expected) still ends up in the crop.
                  const paddedSub = {
                    ...subBounds,
                    yStartPct: Math.max(0, subBounds.yStartPct - 3),
                    yEndPct: Math.min(100, subBounds.yEndPct + 3),
                  };
                  const cropped = await cropPageByBounds(pageBuffer, paddedSub, paddedSub.pageIndex);
                  parts.push({ text: `Student's handwritten answer for part (${sp.label}):` });
                  parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: cropped.toString("base64") } });
                  hasSubmission = true;
                } catch { /* page missing too — fall through */ }
              }
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
          return;
        }
        // Fallback: try combined image. Track that we fell back so
        // the detect-prompt below doesn't tell the AI to "report
        // each part separately" — there are no per-part images, just
        // one canvas with everything on it. The old prompt made the
        // AI default to "(a) blank (b) blank" when parts weren't
        // visually separated, even though writing was clearly there.
        let usedCombinedFallback = false;
        if (!hasSubmission) {
          try {
            const pagePath = path.join(subDir, `page_${scanPageIdx}.jpg`);
            const pageBuffer = await fs.readFile(pagePath);
            // Crop to the question's writing area when we have
            // printableBounds (set during clean-extract printable
            // PDF generation). Falls back to the whole page when
            // bounds are missing, so legacy in-app canvas papers
            // (no printable cycle) still mark the same as before.
            // submissionPage = bounds.pageIndex (NOT scanPageIdx)
            // so cropPageByBounds's internal page-match check passes.
            // Pad the bounds vertically (~3% above, ~3% below) so
            // student handwriting that overflows the printed box —
            // e.g. running below the last line or above the first
            // — stays in the crop. Without the pad we sometimes
            // truncate the answer and the AI reads "blank" / a
            // partial sentence.
            const boundsRaw = (q.printableBounds as PrintableBounds | null | undefined) ?? null;
            const bounds = boundsRaw && Number.isFinite(boundsRaw.pageIndex) ? {
              ...boundsRaw,
              yStartPct: Math.max(0, boundsRaw.yStartPct - 3),
              yEndPct: Math.min(100, boundsRaw.yEndPct + 3),
            } : boundsRaw;
            const cropped = await cropPageByBounds(pageBuffer, bounds, bounds?.pageIndex ?? i);
            parts.push({ text: realSubs.length > 0
              ? "Student's handwritten answer (single combined canvas covering all sub-parts — they share one writing area, not separate per-part images):"
              : "Student's handwritten answer:" });
            parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: cropped.toString("base64") } });
            hasSubmission = true;
            usedCombinedFallback = realSubs.length > 0;
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
          return;
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
╔══════════════════════════════════════════════════════════════════╗
║  ANTI-HALLUCINATION — READ CAREFULLY                              ║
║                                                                    ║
║  You are a TRANSCRIBER, not a solver. Your job is to copy what    ║
║  the student wrote in BLUE INK on the image. You are FORBIDDEN    ║
║  from:                                                             ║
║    - Solving the problem yourself                                 ║
║    - Inventing working / steps the student did not write          ║
║    - Adding labels, units, or numbers that aren't in the image    ║
║    - "Cleaning up" a wrong answer into the right one              ║
║                                                                    ║
║  If the student wrote ONLY a final answer with no working, you    ║
║  MUST report "Working: (no working shown)" and the final answer   ║
║  exactly as written — even if you can compute the "right" answer  ║
║  and want to add the working that would get there. DON'T.         ║
║                                                                    ║
║  If the student wrote a clearly WRONG answer (e.g. "7:3" when     ║
║  the right answer is "2:3"), report "7:3". Do NOT auto-correct    ║
║  to "2:3" and claim "transcription error" — that's a marking      ║
║  decision, not a transcription one. You are NOT marking yet.      ║
╚══════════════════════════════════════════════════════════════════╝

IMPORTANT — FINAL ANSWER: Look for the "Ans:" line at the bottom-right of the answer area. The value written on or near this line is the student's FINAL ANSWER. Report this as the primary answer.

CRITICAL — PRESERVE UNITS AND SYMBOLS: Copy the final answer EXACTLY as written, including every unit and symbol the student put next to the number. Do NOT strip ° / cm / m / kg / g / ml / $ / % / ² / ³ / fractions — if the student wrote "21°" report "21°", if they wrote "5 cm" report "5 cm". If the unit was printed next to the Ans: line by the paper (not written by the student), still include it in the reported final answer so marking can compare against the expected answer with units.

GEOMETRIC SYMBOLS — DON'T SPLIT INTO LETTERS: Handwritten geometric symbols are ONE token each — never break their strokes into adjacent letters. The most-confused ones:
- ⊥ (perpendicular) has a vertical stroke + a horizontal stroke at the bottom. Read this as the single symbol "⊥". Do NOT report it as "⊥ L" (mistaking the horizontal stroke for a separate "L" before the next label) or as "L" alone. If the student wrote "VW ⊥ WX", transcribe "VW ⊥ WX" — NOT "VW ⊥ LWX".
- ∥ (parallel) is two vertical strokes. Don't read it as "||" or "ll".
- ∠ (angle) is one symbol, not "<" + a letter.
- ≅ / ≡ (congruent / identical) are single tokens, not "=" + something.
When the symbol is followed immediately by a label like "WX" or "AB", the symbol's own strokes can blur into the first letter — be careful to keep the symbol whole and the label clean.

FORMAT: Put each line of working on a SEPARATE line. Do NOT merge numbers from different lines into one.
For example, if the student wrote:
  Angle x = 180° − 2 × 35°
  = 110°
  Ans: 110°
Report it as:
  Working: Angle x = 180° − 2 × 35° = 110°
  Final answer: 110°

If the student wrote ONLY "7:3" with no working at all, report:
  Working: (no working shown)
  Final answer: 7:3

If the student drew a diagram (e.g. bar model, number line, shapes, arrows), describe it briefly (e.g. "Drew a bar model: 3 units = 42, 1 unit = 14").

SMALL / SHORT ANSWERS: Single digits (e.g. "4", "7") or single letters (e.g. "A") may be small and easy to miss. Scan the ENTIRE answer area carefully — especially near "Ans:" lines and in the top-right corner of sub-part regions. A thin blue stroke that resembles a digit IS the student's answer. Do NOT default to "blank" if there is any blue ink mark present.

${usedCombinedFallback ? `MULTI-PART ON ONE CANVAS — CRITICAL:
The image is ONE combined canvas the student used for all sub-parts. There are NO separate per-part images. Sub-parts may not be labelled or visually separated by the student.
- Do NOT default to "blank" just because parts aren't labelled — read all the writing and attempt to map it to (a), (b), (c) etc. in the order it appears.
- If multiple distinct calculations / answers are visible, assume each one corresponds to the next sub-part in order.
- If only one block of working is visible and all sub-parts share it (e.g. shared fraction work yielding two answers on a "Final answer:" line), copy that working under EACH part with the appropriate final answer.
- Only report a part as "blank" if you genuinely see nothing that could correspond to it after exhausting the above.
` : realSubs.length > 0 ? `SUB-PARTS — REQUIRED FORMAT:
This question has sub-parts ${realSubs.map(s => `(${s.label})`).join(", ")}. You MUST prefix each sub-part's transcription with its label so the review UI can split them:
  (a) Working: ... / Final answer: ...
  (b) Working: ... / Final answer: ...
Even when a sub-part is blank, write the label: "(b) blank". Without the (a) / (b) labels the parent's review screen cannot display your transcription per-part.
` : ""}

╔══════════════════════════════════════════════════════════════════╗
║  OUTPUT FORMAT — MANDATORY                                        ║
║                                                                    ║
║  Your response MUST start with EXACTLY these two lines (in this   ║
║  order, no quotes, no markdown, no extra characters):             ║
║                                                                    ║
║    HANDWRITING: PRESENT|ABSENT                                    ║
║    TRANSCRIPTION: FOUND|EMPTY                                     ║
║                                                                    ║
║  HANDWRITING: PRESENT — any ink/marks visible (even ONE stroke).  ║
║  HANDWRITING: ABSENT  — canvas truly blank, no ink anywhere.      ║
║                                                                    ║
║  TRANSCRIPTION: FOUND — you read at least one digit/letter/word/  ║
║                          shape. Transcribe it on lines below.     ║
║  TRANSCRIPTION: EMPTY — you see ink but cannot interpret it       ║
║                          (illegible/faint/scribbles). Use EMPTY   ║
║                          whenever your transcription would        ║
║                          otherwise be "(blank)", "(no working     ║
║                          shown)", "(illegible)", or similar —     ║
║                          EVEN IF HANDWRITING is PRESENT.          ║
║                                                                    ║
║  After the two markers, transcribe per the rules above. If        ║
║  TRANSCRIPTION: EMPTY, you may stop after the markers.            ║
║                                                                    ║
║  Example output (PRESENT + FOUND):                                ║
║    HANDWRITING: PRESENT                                           ║
║    TRANSCRIPTION: FOUND                                           ║
║    Working: 145 ÷ 2 = 72.5                                        ║
║    Final answer: 72.5°                                            ║
║                                                                    ║
║  Example output (truly blank canvas):                             ║
║    HANDWRITING: ABSENT                                            ║
║    TRANSCRIPTION: EMPTY                                           ║
╚══════════════════════════════════════════════════════════════════╝` });

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
          // Drawable questions (food web with multiple arrows, plot a
          // graph, shade regions) need vision quality flash can't
          // reliably deliver — observed case: a P6 Science food-web
          // OEQ where flash mis-read several arrow directions, and a
          // P6 math shaded-region question where flash described the
          // wrong cell. Drawables are pinned to 3.1-pro with no
          // fallback — degrading to flash silently swaps a correct
          // mark for a wrong one. The per-model retry loop below
          // still handles transient 5xx with 4s/8s backoff.
          // Plain handwritten paragraphs stay on flash — cheaper and
          // accurate enough at handwriting OCR.
          const detectModels = isDrawableAny
            ? ["gemini-3.1-pro-preview"]
            : ["gemini-2.5-flash"];
          let detectErr: unknown = null;
          for (let i = 0; i < detectModels.length; i++) {
            // Per-model retry with backoff on 503/429/504 before falling
            // through to the next model. Three attempts at 4s/8s back off
            // covers most transient Google capacity spikes without
            // blowing the per-paper marking budget.
            let modelErr: unknown = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const detectResponse = await withTimeout(
                  ai.models.generateContent({
                    model: detectModels[i],
                    contents: [{ role: "user", parts: detectParts }],
                    config: { temperature: 0.1 },
                  }),
                  GEMINI_TIMEOUT_MS,
                  `quiz-detect-q${q.questionNum}`,
                );
                detectedAnswer = detectResponse.text?.trim() ?? "";
                if (i > 0) console.log(`[quiz-marking] Q${q.questionNum} detect: fell back to ${detectModels[i]}`);
                if (attempt > 0) console.log(`[quiz-marking] Q${q.questionNum} detect (${detectModels[i]}) succeeded on attempt ${attempt + 1}`);
                console.log(`[quiz-marking] Q${q.questionNum} detected (${detectModels[i]}): "${detectedAnswer.substring(0, 100)}"`);
                modelErr = null;
                detectErr = null;
                break;
              } catch (err) {
                modelErr = err;
                const status = (err as { status?: number }).status;
                const retryable = status === 503 || status === 429 || status === 504;
                if (!retryable || attempt === 2) break;
                const wait = 4000 * (attempt + 1);
                console.warn(`[quiz-marking] Q${q.questionNum} detect (${detectModels[i]}) ${status}, retrying in ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
              }
            }
            if (modelErr === null) break;
            detectErr = modelErr;
            if (i < detectModels.length - 1) {
              console.warn(`[quiz-marking] Q${q.questionNum} detect with ${detectModels[i]} exhausted, trying ${detectModels[i + 1]}:`, modelErr instanceof Error ? modelErr.message : modelErr);
            }
          }
          if (detectErr) console.error(`[quiz-marking] Q${q.questionNum} detection failed across all models:`, detectErr);

          // Strip the OUTPUT FORMAT marker lines if flash emitted them
          // (defensive — keeps downstream marking working whether or not
          // the model complied with the prompt format).
          const lines = detectedAnswer.split("\n");
          const line1 = (lines[0] ?? "").trim();
          const line2 = (lines[1] ?? "").trim();
          const isMarker1 = line1 === "HANDWRITING: PRESENT" || line1 === "HANDWRITING: ABSENT";
          const isMarker2 = line2 === "TRANSCRIPTION: FOUND" || line2 === "TRANSCRIPTION: EMPTY";
          const markerSaysEmpty = line1 === "HANDWRITING: ABSENT" || line2 === "TRANSCRIPTION: EMPTY";
          if (isMarker1 && isMarker2) {
            detectedAnswer = lines.slice(2).join("\n").trim();
          } else if (isMarker1) {
            detectedAnswer = lines.slice(1).join("\n").trim();
          }

          // Cheap LLM-as-judge: ask flash to classify whether the
          // transcription contains real student work or just various
          // phrasings of "blank/empty/illegible/no answer". Replaces
          // brittle string matching against AI output — the judge handles
          // unlimited phrasing variations (blank, (no working shown),
          // illegible, nothing visible, I cannot read this, etc.) with
          // one cheap text-only call.
          const usedFlashOnly = detectModels.length === 1 && detectModels[0] === "gemini-2.5-flash";
          const inkSubpartsPresent = realSubs.length > 0 && blankSubparts.size < realSubs.length;
          const inkPresentOverall = realSubs.length === 0 ? hasSubmission : inkSubpartsPresent;
          let judgedEmpty = false;
          // Skip the judge when flash's compliant marker already says EMPTY
          // (saves a call) and when transcription is genuinely empty after
          // marker stripping (nothing to judge).
          if (usedFlashOnly && inkPresentOverall && !markerSaysEmpty && detectedAnswer.length > 0) {
            try {
              const judgePrompt = `Below is an AI's transcription of a student's handwritten exam answer.

Decide whether the transcription contains ACTUAL student work (numbers, letters, words, equations, descriptions of student-drawn marks) OR whether it is only phrases meaning the canvas was blank/illegible/empty.

Transcription:
"""
${detectedAnswer}
"""

Answer with EXACTLY one word, nothing else: YES or NO.
YES = real student work is present.
NO = the transcription consists only of phrases like "blank", "(no working shown)", "(empty)", "illegible", "nothing visible", "I cannot read this", "no answer", or similar — NO actual student work.`;
              const judgeResponse = await withTimeout(
                ai.models.generateContent({
                  model: "gemini-2.5-flash",
                  contents: [{ role: "user", parts: [{ text: judgePrompt }] }],
                  config: { temperature: 0, responseMimeType: "text/plain" },
                }),
                15_000,
                `quiz-detect-q${q.questionNum}-judge`,
              );
              const judgeText = (judgeResponse.text ?? "").trim().toUpperCase();
              judgedEmpty = judgeText.startsWith("NO");
              console.log(`[quiz-marking] Q${q.questionNum} judge: "${judgeText.slice(0, 20)}" → ${judgedEmpty ? "empty (will escalate)" : "has content"}`);
            } catch (err) {
              console.warn(`[quiz-marking] Q${q.questionNum} judge failed, assuming has content:`, err instanceof Error ? err.message : err);
            }
          }

          // Escalate to pro when ink is confirmed present AND either:
          //   - flash's compliant marker said ABSENT/EMPTY, OR
          //   - judge said the transcription is just blank-phrasing
          const shouldEscalate = usedFlashOnly && inkPresentOverall && (markerSaysEmpty || judgedEmpty);
          // Local helper — strips the OUTPUT FORMAT marker lines off a
          // detection response so the downstream marker sees just the
          // transcription. Identical logic to the inline strip above.
          const stripMarkerLines = (raw: string): string => {
            const xs = raw.split("\n");
            const a = (xs[0] ?? "").trim();
            const b = (xs[1] ?? "").trim();
            const ma = a === "HANDWRITING: PRESENT" || a === "HANDWRITING: ABSENT";
            const mb = b === "TRANSCRIPTION: FOUND" || b === "TRANSCRIPTION: EMPTY";
            if (ma && mb) return xs.slice(2).join("\n").trim();
            if (ma) return xs.slice(1).join("\n").trim();
            return raw;
          };
          // Decide afresh whether a candidate detection text is still a
          // read failure — drives the OpenAI fallback below.
          const looksUnreadable = (txt: string): boolean => {
            if (!txt) return true;
            const u = txt.toUpperCase();
            // Pro / flash sometimes return only the marker pair with no
            // transcription body when they couldn't read the ink.
            if (/HANDWRITING:\s*ABSENT/.test(u) || /TRANSCRIPTION:\s*EMPTY/.test(u)) return true;
            return false;
          };
          if (shouldEscalate) {
            const reason = markerSaysEmpty ? "marker said ABSENT/EMPTY" : "judge said empty";
            console.log(`[quiz-marking] Q${q.questionNum}: ${reason} but ink present — retrying with gemini-3.1-pro-preview`);
            try {
              const retry = await withTimeout(
                ai.models.generateContent({
                  model: "gemini-3.1-pro-preview",
                  contents: [{ role: "user", parts: detectParts }],
                  config: { temperature: 0.1 },
                }),
                GEMINI_TIMEOUT_MS,
                `quiz-detect-q${q.questionNum}-retry`,
              );
              const retryAns = retry.text?.trim() ?? "";
              if (retryAns) {
                const stripped = stripMarkerLines(retryAns);
                console.log(`[quiz-marking] Q${q.questionNum} pro re-detect: "${stripped.substring(0, 100)}"`);
                detectedAnswer = stripped;
              }
            } catch (err) {
              console.warn(`[quiz-marking] Q${q.questionNum} pro retry failed:`, err instanceof Error ? err.message : err);
            }

            // ── FINAL FALLBACK: OpenAI gpt-5.4 ──
            // If pro ALSO couldn't transcribe the handwriting, try one
            // more time against OpenAI — a different vendor genuinely
            // helps on some scans where Gemini gives up. P6 Ratio Q8 in
            // the recent eval is the headline case: pixel ink was
            // present, both flash and pro returned EMPTY, the marker
            // wrote "Could not read student's answer" and awarded 0/4
            // for a question the student had answered correctly.
            if (looksUnreadable(detectedAnswer) && isOpenAIFallbackEnabled()) {
              console.log(`[quiz-marking] Q${q.questionNum}: pro also EMPTY — falling back to OpenAI gpt-5.4`);
              try {
                const openaiResp = await runOpenAIFallback(
                  { model: "gemini-3.1-pro-preview", contents: [{ role: "user", parts: detectParts }] },
                  `quiz-detect-q${q.questionNum}-openai`,
                );
                const openaiAns = openaiResp.text?.trim() ?? "";
                if (openaiAns) {
                  const stripped = stripMarkerLines(openaiAns);
                  if (stripped && !looksUnreadable(stripped)) {
                    console.log(`[quiz-marking] Q${q.questionNum} OpenAI re-detect: "${stripped.substring(0, 100)}"`);
                    detectedAnswer = stripped;
                  } else {
                    console.log(`[quiz-marking] Q${q.questionNum} OpenAI also returned EMPTY — accepting unreadable state`);
                  }
                }
              } catch (err) {
                console.warn(`[quiz-marking] Q${q.questionNum} OpenAI re-detect failed:`, err instanceof Error ? err.message : err);
              }
            }
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
The student's drawing image is labelled "Student's actual drawing(s)" above. The expected answer image is labelled "Expected answer image (ground truth)". They are TWO DIFFERENT images — do not conflate them.

CRITICAL — ANTI-HALLUCINATION (read first):
You must analyse the student's image by LOOKING AT IT DIRECTLY. Do NOT assume the student drew what the expected image shows. Blue ink confirmed by a pixel check may be stray marks, wrong-position strokes, or an unrelated scribble — not the expected mark. Common failure mode: the expected image shows "an X between the 2nd and 3rd notch" and the marker describes the student's image as also having "an X between the 2nd and 3rd notch" even though the student drew no such X there. This is wrong. If the student drew something different — wrong position, wrong shape, or only random strokes — report what they ACTUALLY drew; Student count for the requested mark may be 0 even when ink is present elsewhere.

MANDATORY PROCEDURE — the notes field MUST begin with this header (exact format):
    Expected: <N>. Student: <M>. Extras: <X>. Missing: <Y>.
Where N = count of required marks in the expected image, M = count of those same required marks the student drew correctly, X = unwanted marks the student added anywhere, Y = required marks the student didn't draw at all. All four numbers required, even if zero.

After the header, on a new line, include:
    Evidence: <describe ONLY what you see in the student's image — pretend the expected image doesn't exist for this sentence>.
If the student drew nothing relevant, say so verbatim, e.g. "Evidence: student drew two short scribbles in the middle of the canvas; no X between notches." In that case Student=0 and Missing=1.

Steps to follow:
1. **Expected-image audit.** Count discrete marks in the expected image and note positions.
2. **Student-image audit.** LOOK AT THE STUDENT'S IMAGE ONLY. Describe each visible ink mark by position/shape. Do not reference the expected image while writing this step.
3. **Diff.** Any mark in the student's image not in the expected image (wrong position/shape/irrelevant) is an EXTRA. Any mark in the expected image not drawn by the student is MISSING.
4. **Verdict.**
   - Extras = 0 AND Missing = 0 AND positions match → FULL MARKS.
   - Any extras OR missing on a 1-mark question → 0 marks.
   - 2-mark question with partial match → proportional partial credit.

The header line is the source of truth. A downstream check clamps marks to 0 if extras or missing > 0.

CRITICAL rules:
- Drawing MORE than the expected image shows (extras) = error. Don't hand-wave past extras.
- Drawing LESS than the expected image shows (missing) = error.
- Ink present does NOT mean the student drew the right thing. Verify visually.
- If the text expected answer says e.g. "shade the opaque material", still do the image audit; the image is authoritative.
- NEVER award full marks unless every mark's position/shape in the student image matches the expected image directly.
- Example: "Expected: 1. Student: 0. Extras: 1. Missing: 1. Evidence: student drew a curved stroke near the base of the number line; no X between notch 2 and notch 3. → 0 of 1 mark."
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
- The expected answer key may include AUXILIARY identifications such as "x = ∠BDC" or "let y be …" or "this angle is alternate to …". These are reasoning hints, NOT required parts of the student's answer. If the student's final NUMERICAL/value answer matches the key, award FULL MARKS even if they omit these labels or angle identifications. Example: question is "find ∠x", key is "180 − 105 − 32 = 43° | x = ∠BDC", student wrote "43°" → FULL MARKS.
- ONLY when the final answer is WRONG or absent: scan the working steps for partial credit. Award partial marks proportional to marksAvailable if some steps or methods are correct.
- IF THE WORKING REACHES THE CORRECT ANSWER but the student wrote a different number on the "Final answer" line (very common transcription/write-down slip — e.g. working shows "108 − 70 = 38" but final-answer line says "88"), trust the working and award FULL MARKS. The student did the math correctly; they just mis-copied at the end. EXCLUSIONS — the following are WRONG ANSWERS, NOT transcription errors: (a) ratio order reversed (working "B:W = 3:7", final "7:3"); (b) units swapped or omitted; (c) negative/positive sign flipped; (d) different number with no working bridge to the right one. Apply the cap below.

SUB-PART LABEL SWAP (applies before the wrong-answer cap):
If the question has subparts (e.g. (a) and (b)) AND the student's answer area clearly contains BOTH expected values but written under SWAPPED labels (their "(a)" = the expected (b) value, their "(b)" = the expected (a) value), treat this as a label mix-up, NOT two wrong answers.
  · WITH WORKING that shows the student understood which value belongs to which subpart (e.g. working for ∠ABF derives 64°, working for ∠DAE derives 67°, and only the final "Ans:" lines are labelled wrong way round) → award FULL MARKS for both subparts. The student got the math AND the reasoning right; the only mistake is the bookkeeping at the ANS lines.
  · WITHOUT WORKING (or with working that doesn't tie either subpart to its method) → award (marksAvailable − 1) marks TOTAL across the two subparts. A 4-mark question (2+2) → 3 marks total; a 2-mark question (1+1) → 1 mark total. Distribute the awarded marks so no subpart exceeds its own marksAvailable.
  · In notes: "Student swapped (a)/(b) labels — both numerical answers correct, deducted 1 mark for the label mix-up."
The rule does NOT fire unless BOTH expected values appear in the student's writing. If only one is present, mark each subpart normally.

⚠️ WRONG-ANSWER CAP (NON-NEGOTIABLE — for math OEQ; also applies inside parts[]):
A wrong final answer can NEVER receive full marks. Cap = (marksAvailable − 1) for the part. Within the cap:
  - 2-mark question/part wrong → MAX 1
  - 3-mark question/part wrong → MAX 2 (1 if EARLY MISSTEP; 2 ONLY if the only slip is in the FINAL arithmetic step)
  - 4-mark question/part wrong → MAX 3 (1-2 if early misstep; 3 only if just the last step)
  - 5-mark question/part wrong → MAX 4 (1-3 if early misstep; 4 only if just the last step)

DEFINITIONS (read carefully — this is where marking errors usually creep in):
  - "EARLY MISSTEP" = a wrong OPERATION, wrong SETUP, wrong FORMULA, or any conceptual error in steps 1 to (n−1) of an n-step solution. Examples: adding instead of subtracting overlapping regions (inclusion-exclusion), using "+" where the question requires "−", picking the wrong fraction-of-remainder base, mis-applying a ratio direction in setup, omitting a controlled variable. The whole rest of the working then uses wrong inputs, even if the arithmetic on those wrong inputs is mechanically correct. THIS IS NOT A "SMALL SLIP" — it caps at the LOWER tier (1 on a 3-mark, 1-2 on 4-mark, 1-3 on 5-mark).
  - "SMALL SLIP" = a final-step arithmetic error only — the setup, method, formula, intermediate values were all correct, and the student just mis-added / mis-multiplied at the very end. Only this qualifies for the HIGHER tier (2 on 3-mark, 3 on 4-mark, 4 on 5-mark).
  - "Correctly executed step" requires BOTH the operation AND the input values to that step to be correct. A step like "8 ÷ 2 = 4" is not "correct" if "2" came from a wrong earlier calculation — it's executing right arithmetic on wrong inputs, which does NOT earn the step's mark.

NOTE: The MAX values above are CAPS, not defaults. Justify any award strictly using the definitions above; default to the LOWER tier when uncertain.
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

CONTEXT-FROM-STEM RULE (Science — applies BEFORE phrase deduction below):
The question stem (text + image) was provided above. Anything the stem ALREADY ESTABLISHES — named objects, scope ("two plants", "both balls"), the experimental setup, observable givens ("water level X after plasticine is added") — is CONTEXT, not something the student must re-state to score.

The marking point is the NEW assertion / inference the student must produce. Do NOT deduct for missing words that the stem already gave.

Examples:
- Stem: "The diagram shows two plants." Key: "Part X of both plants absorbs water and mineral salts." Student: "Part X absorbs water and mineral salts." → "both plants" is established scope. Award full credit; the student's statement applies to the same Part X already named in the stem.
- Stem describes an observable setup ("X shows the water level after plasticine is added"). Key: "The water level dropped." → "water level" is stem context; the INFERENCE the student must produce is "dropped / decreased". If the student concludes the level dropped (in any wording), award the point. Only deduct if the student's reasoning never addresses the level's change. Frame any deduction as "the level-change inference was missing", NOT "did not say water level".

Default: when borderline between stem-context and new-inference, lean ACCEPT. Penalising students for omitting words the question already gave them is a common false-positive — avoid it.

SCIENCE MARKING — PHRASE-BY-PHRASE DEDUCTION (IMPORTANT):
Primary-school Science answers are marked against the SPECIFIC phrases in the answer key, not against a vague concept. The answer key has been written by a human marker and EVERY phrase in it is load-bearing — it tests a discrete piece of knowledge the student is expected to demonstrate.

PROCESS:
1. Break the answer key into its distinct marking-point phrases. Each phrase is one of:
   (a) a named scientific term ("photosynthesis", "ovum", "chlorophyll"),
   (b) a clause describing a process or mechanism ("water loses heat", "energy is released", "the bulb glows brighter"),
   (c) a function or purpose statement ("the function is to absorb water", "to protect against predators"),
   (d) a property statement ("poor conductor of heat", "good insulator", "soluble in water"),
   (e) a relational link ("...thereby condensing", "...therefore the temperature rises").
   Example: "Water loses heat to the surroundings, thereby condensing." → TWO phrases.
   Example: "Energy is released in respiration." → TWO phrases.
   Example: "Vacuum is a poor conductor of heat so heat cannot pass through it." → THREE phrases.

2. Start at marksAvailable. Deduct 0.5 for each marking-point phrase MISSING from the student's answer (or only vaguely paraphrased without the key idea). Floor at 0.

3. A paraphrase ONLY counts as present if it captures the same scientific meaning AND uses a recognised scientific equivalent for any named term in that phrase. Everyday paraphrase that loses the named term → MISSING.
   - "joining of male and female cells" is NOT equivalent to "fertilisation".
   - "the heat moves" IS equivalent to "heat is transferred".
   - "the gas was kept inside" IS NOT equivalent to "energy is released".

4. If the student's answer captures NONE of the answer-key phrases (or is blank / fully off-topic), award 0.

5. Internally apply the per-phrase logic above, but in the notes field write plain feedback for a parent and child to read.

NOTES STYLE — STRICT:
  - One short paragraph, 1–2 sentences total.
  - Lead with what the student got right (briefly).
  - Then say plainly what was missing or wrong, wrapping each missing key phrase / named term in **double asterisks**.
  - End with a one-clause deduction reason like "−0.5 for not stating the function" or "−0.5 because **respiration** was not named".

NOTES — FORBIDDEN PATTERNS (DO NOT USE ANY OF THESE):
  - Labels like "PRESENT", "MISSING", or "marking point (1)/(2)/(3)".
  - Tables or numbered lists of marking points.
  - Scaffolding like "Marking points: (1) X, (2) Y" or "Per-phrase: ..." or "(1) PRESENT (2) MISSING".
  - Score summaries like "Starting 4/4, -0.5 for each MISSING. Awarded 2.5/4." or "Score: 2/3" or "Awarded 1.5/2".
  - The phrase "Starting X/X" in any form.
  - ANY restatement of marksAwarded inside the notes — the marks number lives in marksAwarded, not in notes.

These forbidden patterns are debug scaffolding from earlier prompts. The current notes field is read by a primary-school student and their parent — write for them, not for a marker rubric.

WORKED EXAMPLE (notes style):
  Part (a) — answer key "Plant F grew to cover the surface | blocked light from reaching plant G | Plant G could not photosynthesise | so plant G died." Student wrote "F blocks light".
  GOOD notes: "Correctly captured that **F blocks light**, but did not explain that **plant F grew to cover the surface**, that **plant G could not photosynthesise**, or that **plant G died**. −1.5 across three missing points."
  BAD notes (FORBIDDEN): "Starting 2/2. Missing Plant F grew to cover the surface (-0.5), Plant G could not photosynthesise (-0.5), and died (-0.5). Awarded 0.5/2."

LABELLED-LIST ANSWERS (IMPORTANT — special case):
When a part's answer key takes the form "<LABEL>: <value> | <LABEL>: <value> | <LABEL>: <value>" — for example "A: nose | B: windpipe | C: lungs", "P: heart | Q: lung", "1: oxygen | 2: carbon dioxide", or "X: evaporation | Y: condensation" — EACH labelled entry is a SEPARATE marking point. The student must provide a correct label for EACH item, not just one.
- Within a single label, "/" separates ACCEPTABLE alternatives (e.g. "nose / nostril" = nose OR nostril is accepted for that one label).
- Between labels, "|" separates SEPARATE labels the student must each get right.

SCORING for labelled-list answers (apply STRICTLY, override the general 0.5-deduction rule for this pattern):
- 1-mark part with N labels (N ≥ 2): all-or-nothing within rounding. Each label is worth 1/N. Sum correct labels and round DOWN to the nearest 0.5. Concretely:
    N=2: 1/2 correct → 0.5; 2/2 → 1; 0/2 → 0.
    N=3: 1/3 correct → 0 (0.33 rounds down to 0); 2/3 → 0.5; 3/3 → 1.
    N=4: 1/4 → 0; 2/4 → 0.5; 3/4 → 0.5; 4/4 → 1.
  DO NOT award the full 1 mark unless ALL labels are correct.
- 2-mark part with N labels: each label worth 2/N. Sum and round DOWN to nearest 0.5.
- 3-mark or higher with N labels: each label worth marksAvailable/N. Standard rounding.

WORKED EXAMPLE — labelled list:
  Part (a) — "Name the parts A, B and C [1 mark]." Answer key "A: nose / nostril | B: windpipe | C: lungs / lung." Student wrote "lung" for C only (B and A left blank).
  Correct labels = 1/3. Score = floor(1/3 × 1 to nearest 0.5) = 0. Awarded 0 mark(s).
  GOOD notes: "Correctly identified **lungs** for C, but did not name **nose/nostril** for A or **windpipe** for B. With only 1 of 3 labels correct, no marks are awarded for this 1-mark part."

KEY-TERM REQUIREMENT (IMPORTANT):
When the expected answer contains a specific scientific TERM that names the underlying concept being tested (e.g. fertilisation, photosynthesis, chlorophyll, evaporation, condensation, respiration, germination, pollination, dissolved, freezing, melting, gravity, friction, conductor, insulator, transparent, opaque, food chain, predator, prey, habitat, community, population, ecosystem, organism, producer, consumer, decomposer, ovum, ovule, sperm, pollen), the student's answer MUST contain that exact term (or a recognised scientific equivalent — NOT a vague everyday paraphrase).
- 'fertilisation' must appear as 'fertilisation' / 'fertilization'. 'joining of male and female cells' is NOT a substitute — it describes the process but doesn't name it. Mark 0 for that concept.
- Synonyms allowed only when they are scientifically interchangeable (e.g. 'water vapour' ≈ 'gas form of water'). When in doubt, treat the missing term as missing.
- This rule overrides the synonym leniency above for these named terms — be strict about terminology, lenient about prose around it.

DISCRIMINATING TERMS (IMPORTANT — STRICTEST):
Some scientific terms have close-but-different neighbours that often confuse students. When the answer key uses one term and the student writes a related-but-WRONG term, score it as WRONG for that concept — partial credit does NOT apply, even if the answer is otherwise on-topic.

Examples (not exhaustive — apply the same principle to any pair of related terms):
- ovum vs ovule (animal egg cell vs plant egg cell)
- ovule vs ovary (cell vs container)
- sperm vs pollen (animal vs plant male gamete)
- mass vs weight (matter vs gravitational force)
- evaporation vs condensation vs boiling (different phase changes)
- voltage vs current (potential difference vs flow rate)
- respiration vs photosynthesis (gas exchange/energy release vs food-making)
- transmit vs absorb vs reflect (opposite light interactions)
- transparent vs translucent vs opaque (different transmission levels)
- conductor vs insulator (opposite electrical/thermal properties)
- predator vs prey (opposite food-chain roles)
- producer vs consumer vs decomposer (different trophic levels)
- inhale vs exhale (opposite breathing directions)
- artery vs vein (different blood-vessel types)
- germinate vs reproduce vs grow (different life-cycle stages)
- dissolve vs melt (solute-in-solvent vs phase change)

Rule: if the answer key's discriminating term is X and the student writes a different-but-related Y from the same conceptual family, score that concept as 0 in the partial-credit calculation. State in notes which discriminating term was wrong, wrapped in **double asterisks** (e.g. "Student wrote **ovule** instead of the required **ovum**.").

DEFINITION QUESTIONS (IMPORTANT — STRICT):
When the question asks the student to DEFINE or EXPLAIN what a term means (e.g. "What is a community?", "Define a population", "Explain what a habitat is", "What is photosynthesis?"), the marking is significantly STRICTER than for a regular reasoning question. Definition questions test exact knowledge of a textbook definition, not approximate understanding.

PROCESS:
1. The term being defined is in the QUESTION — the student does not need to repeat it.
2. Read the expected answer and list its DISCRIMINATING COMPONENTS — the parts that distinguish this term from neighbouring concepts (e.g. "different populations" is what distinguishes a community from a population; "in the presence of sunlight" is what distinguishes photosynthesis from other plant processes).
3. Award marks ONLY when the student's answer contains every discriminating component (or its scientifically interchangeable synonym). Vague paraphrase that "captures the gist" does NOT earn marks here.

SCORING TABLE (apply strictly):
- 1-mark definition question: all-or-nothing. Missing ANY discriminating component → 0. Don't award half a mark.
- 2-mark definition question: full marks ONLY if every discriminating component is present. Missing one of two key components → 1. Missing both → 0. An answer that "broadly captures the idea" but no specific terms → 0.
- 3+ mark definition question: deduct one mark per missing discriminating component, never below 0.

ANCHOR EXAMPLES (use these to calibrate strictness):
- Q: "What is a community?" Expected: "Different populations of organisms living together in a habitat." (2 marks)
  - "A group of organisms living together" → 0/2. Missing "different populations" (could describe a single population) and missing "habitat". Not specific enough to be a community.
  - "Different populations living together" → 1/2. Has "different populations" but missing "habitat".
  - "Different populations of organisms in a habitat" → 2/2.
- Q: "What is photosynthesis?" Expected: "The process by which plants use sunlight to make food (glucose) from water and carbon dioxide." (2 marks)
  - "Plants make food" → 0/2. Missing the entire mechanism — sunlight, water, carbon dioxide. Vague paraphrase, not a definition.
  - "Plants make food using sunlight" → 1/2.
  - "Plants use sunlight to make food from water and carbon dioxide" → 2/2.

In notes: write each discriminating component with **double asterisks** and tick / cross each one. Be explicit ("missing **habitat**"). Never give a definition question full marks unless every discriminating component is present.

SCIENCE — UNKEYED-BUT-VALID ANSWERS (IMPORTANT):
Answer keys are NOT exhaustive. Sometimes a student gives a scientifically valid, observation-grounded answer that directly addresses the question but isn't listed in the expected answer.
- If the student's answer (a) is scientifically correct at primary-school level, (b) directly answers what the question asks, and (c) is consistent with the diagram / context provided, AWARD CREDIT proportional to how completely it addresses the question — even if no concept overlaps with the expected answer.
- Use this rule sparingly and only when the alternative reasoning is clearly valid science. Do NOT use it to rescue partial / vague / off-topic answers.
- When applying this rule, prefix the notes with "[Alternative valid answer]" so the parent can spot it during review and override if they disagree.
- Do NOT apply this rule for English questions, math, or factual recall (e.g. "name the parts of a flower"). Only for Science explanation/reasoning questions where multiple valid lines of reasoning may exist.

SCIENCE KEY-TERM EMPHASIS IN NOTES (IMPORTANT):
In the notes field, wrap every key scientific term or phrase from the expected answer in **double asterisks** so the review UI renders them in bold. Emphasise especially the terms/phrases the student MISSED (the ones that cost them marks).
- Examples of key terms: **photosynthesis**, **chlorophyll**, **evaporation**, **blocks light**, **heat energy is transferred**, **potential energy**.
- If a required concept was missing, name it and bold it: "The student did not mention **chlorophyll** or **sunlight**, so 1 mark was not awarded."
- If the student got a key term right, you may also bold it when calling it out positively.
- Only bold actual key terms/phrases — do not bold ordinary connector words.
` : "";

        // Anti-hallucination guard: when Phase 1 detection (which has
        // already retried with pro if pixel-confirmed ink looked like
        // it might be misread) reports the student's answer as blank,
        // we've seen the marker "find" the expected answer in the
        // image and award full marks — pure false positive. Tell the
        // marker explicitly: detection is the ground truth on what
        // the student wrote. The image is for cross-checking
        // handwriting interpretation, NOT for re-discovering content
        // detection said wasn't there.
        const detectedSaysAllBlank = /^\s*(\(?\w+\)?\s*[:.]?\s*)?(ans\s*[:=]?\s*)?blank\s*$/i.test(detectedAnswer.trim())
          || /^(?:[(\w)\s:.]*\bblank\s*\n?)+$/i.test(detectedAnswer.trim());
        const partsBlankSet = new Set<string>();
        // Seed from the upstream pixel-level ink check. blankSubparts
        // is GROUND TRUTH (we read the ink PNG and found no opaque
        // pixels) — far more reliable than parsing Phase 1's detected
        // text, which sometimes returns junk like ":" for a blank
        // canvas instead of the literal word "blank". Without this
        // seed, the marker has hallucinated full marks for subparts
        // that were physically blank.
        for (const lbl of blankSubparts) partsBlankSet.add(lbl.toLowerCase());
        // Per-part "blank" detection — e.g. "(a) blank", "Part (b): blank",
        // "(c) Ans: blank". Adds the label to partsBlankSet for the prompt.
        for (const m of detectedAnswer.matchAll(/(?:^|[\n|])\s*(?:Part\s*)?\(?([a-z])\)?\s*[:.]?\s*(?:Ans\s*[:=]?\s*)?blank\b/gi)) {
          partsBlankSet.add(m[1].toLowerCase());
        }
        const blankAntiHallucinationClause = (detectedSaysAllBlank || partsBlankSet.size > 0) ? `

DETECTION SAID BLANK — CRITICAL ANTI-HALLUCINATION RULE:
${detectedSaysAllBlank
  ? `Phase 1 detection (which already retried with the strongest model) reports the student's answer is **entirely blank**. Treat the detected answer as ground truth: the student wrote nothing usable. Award 0 marks.`
  : `The following parts are confirmed BLANK (no ink at all on the student's canvas — verified by pixel-level inspection of the ink layer, NOT by reading the image): ${[...partsBlankSet].map(l => `(${l})`).join(", ")}. These parts are ground truth blank. For each of these parts, marksAwarded MUST be 0 and the note MUST say the student left it blank. This is non-negotiable — the canvas was empty.`}
You are FORBIDDEN from "finding" the expected answer in the image when a part is confirmed blank. Do not claim the student "correctly filled in the boxes" / "wrote A, B, C, D, E" / "drew the arrow" / any other content. The canvas had zero pen strokes. If the image you see appears to contain the expected answer, that is the printed question or an overlay — NOT the student's handwriting. The image is for cross-checking handwriting interpretation, NOT for re-discovering content the ink check said wasn't there.
` : "";

        const markPrompt = `You are marking a primary school student's answer. Be concise. Use British English throughout.

Question: ${q.transcribedStem ?? "See image"}
Student's answer (detected from their handwriting): "${detectedAnswer}"
Expected answer: "${expectedAnswer}"
${blankAntiHallucinationClause}
${answerImageNote}${answerImageUsageNote}
Marks available: ${marksAvailable}${partMaxNote}

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

╔══════════════════════════════════════════════════════════════════════╗
║  DETECTION-FAILURE RULE — NO RESCUE MARKING                          ║
║                                                                       ║
║  The "Student's answer" text above came from a separate OCR step.    ║
║  Sometimes that OCR fails: it returns junk (a single ":" / "."       ║
║  / "/", a stray dot, blank, "(a) missing", "[unreadable]") or it     ║
║  returns content that clearly doesn't address the question (e.g.     ║
║  expected "P", detected just ":").                                   ║
║                                                                       ║
║  When that happens, you are FORBIDDEN from:                          ║
║   - Assuming the student "really" wrote the expected answer and      ║
║     awarding marks for it.                                            ║
║   - Writing notes like "student correctly stated P" when the         ║
║     detected text contains no "P".                                    ║
║   - "Rescuing" the answer by treating junk detection as proof the    ║
║     student answered correctly.                                       ║
║                                                                       ║
║  YOU MUST mark on the detected text as given. If the detected text   ║
║  doesn't contain the expected answer, award 0 for that part and      ║
║  note: "Could not read student's answer — please review the scan."   ║
║  The parent will review on the marked-paper view and override if     ║
║  the OCR was simply wrong.                                            ║
║                                                                       ║
║  Examples of detection-failure inputs (assume nothing about what     ║
║  was actually written):                                               ║
║   - student=":" , student="." , student="/"                          ║
║   - student="" , student="(no answer)" , student="[unclear]"         ║
║   - student="(a) missing" , student="blank"                          ║
╚══════════════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════════════╗
║  FINAL ANSWER GOVERNS — NEVER UPGRADE A WRONG FINAL ANSWER          ║
║                                                                      ║
║  The student's FINAL ANSWER (the value next to "Ans:" / "Final      ║
║  answer:" / on the answer line) is what gets marked. If the final    ║
║  answer doesn't match the expected answer, the question is wrong —  ║
║  unless visible WORKING earns proportional credit per the math       ║
║  partial-credit rule.                                                ║
║                                                                      ║
║  You are FORBIDDEN from:                                             ║
║    - Treating a wrong final answer as a "transcription error" and   ║
║      awarding marks for the right calculation in the working.       ║
║    - "Recovering" a correct value from intermediate steps when the  ║
║      student's last line is clearly the wrong number.               ║
║    - Inferring what the student "meant" if their final answer       ║
║      doesn't match the expected answer.                              ║
║                                                                      ║
║  Example: Student writes "7:3" as final answer when expected is     ║
║  "2:3". Score: 0/1 (or partial only if the WORKING from the          ║
║  student's pen, not your own calculation, shows correct steps).     ║
║                                                                      ║
║  Working you should treat as INVENTED (not the student's):          ║
║  - Anything the detected-answer text describes as solving / showing ║
║    "calculation" when the student wrote only a final answer.        ║
║  - "(no working shown)" → ZERO working, mark on final answer alone. ║
╚══════════════════════════════════════════════════════════════════════╝

LATEX MATH: stems and expected answers may contain LaTeX inline math wrapped in single dollar signs, e.g. '$4\\frac{5}{6}$', '$\\frac{29}{6}$'. Treat these semantically — '$4\\frac{5}{6}$' IS the mixed number 4 5/6, '$\\frac{29}{6}$' IS twenty-nine over six. A student who writes "4 5/6" or "29/6" in plain text is giving the same answer; mark accordingly. In YOUR feedback text, write fractions in the SAME LaTeX form (e.g. '$\\frac{5}{6}$' or '$4\\frac{5}{6}$') — the parent UI renders them as proper stacked fractions. Do NOT write bare '4 5/6' or '\\frac{5}{6}' without the surrounding '$' delimiters; either causes the parent to see raw text instead of a rendered fraction.
${drawableMarkRule}${mathAnswerFirstRule}${sciencePartialRule}
ANSWER-KEY GAPS — FAIL-SAFE (IMPORTANT):
Sometimes the expected answer above doesn't cover every part of the question. Examples: a multi-part (a)(b)(c) question whose answer key only mentions part (c); an answer field that's empty, "?", or LITERALLY just "see image" / "see answer image" with no other content (a phrase like "(b) See answer image. The two extra light bulbs must be in parallel..." DOES contain usable text — the sentence after "See answer image." is the key, USE IT, do not fall back); a per-part breakdown where one part says "(no answer key — …)". In those cases:
- For parts that ARE covered by the expected answer: apply the ABSOLUTE RULE strictly — the provided answer is ground truth.
- For parts NOT covered by the expected answer: mark on the student's own merit using your subject knowledge. A scientifically / mathematically valid, on-topic answer that directly addresses that part earns the mark(s) for that part. A blank or off-topic answer earns 0.
- Prefix every per-part note where you applied this fallback with "[AI-judged, no key provided]" so the parent can spot it during review and override if needed.
- DO NOT use this rule as an excuse to overrule a part that the answer key DOES cover. The ABSOLUTE RULE still binds those parts.

Instructions:
1. Compare the student's detected answer against the expected answer (including synonyms and equivalent phrasing). For Science, apply the SCIENCE PARTIAL-CREDIT RULE above — partial credit for partial concept coverage.
   - If correct → FULL MARKS.
   - Partially correct → PARTIAL marks for matching portions.
   - Wrong or blank → ZERO.
2. For multi-part (a), (b), (c): compare each part against its part of the expected answer; for parts with no key, apply the ANSWER-KEY GAPS fail-safe above.
3. In notes: write ONE labelled section per part using EXACTLY this structure (the parser depends on it):
     Part (a): <commentary>. Awarded N mark(s).
     Part (b): <commentary>. Awarded N mark(s).
   - Each part header is "Part (X):" with the colon — required.
   - End each part with a single "Awarded N mark(s)." line that gives the TOTAL marks for that part (sum of any sub-elements). Do NOT write "Awarded 0 marks for the explanation" as the closing line of a part — that's a sub-mention; restate the part total afterwards.
   - For single-part questions, omit the Part header and just state "Awarded N mark(s)." once at the end.
   NEVER propose an alternative answer that contradicts a part the key DOES cover.
4. PER-PART MARKS BREAKDOWN (parts[] in the JSON): for every labelled sub-part you commented on in notes, add one entry to the parts array with the EXACT mark you awarded that part. The top-level marksAwarded MUST equal the sum of parts[].awarded — the server uses parts[] as the source of truth when both are present, so any disagreement gets resolved against your per-part numbers, not the top-level total. For single-part questions, return parts as an empty array []; the top-level marksAwarded stands.

Return ONLY valid JSON:
{"questionId": "${q.id}", "marksAvailable": ${marksAvailable}, "marksAwarded": <number — must equal sum of parts[].awarded for multi-part>, "studentAnswer": "${detectedAnswer.replace(/"/g, '\\"').replace(/\n/g, '\\n')}", "notes": "<feedback>", "parts": [{"label": "a", "awarded": <number>, "max": <number — the cap for this part>}, ...]}`;

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
        // Drawable questions need stronger visual reasoning than flash can
        // reliably provide (flash was marking "7 shaded blocks vs 5
        // expected" as correct). Pinned to 3.1-pro:
        //  - any drawable + answerImageData (every subject) — text key
        //    can mark via prose comparison, image key needs pro vision.
        //  - any drawable science OR math OEQ (even when the key is text
        //    only) — flash kept passing structurally wrong circuit /
        //    particle diagrams in science and miscounted shaded units /
        //    misread geometric labels in math. Both subjects need
        //    spatial reasoning the flash tier can't deliver reliably.
        const paperSubjLc = (paper.subject ?? "").toLowerCase();
        const paperIsScienceOrMath = paperSubjLc.includes("science") || paperSubjLc.includes("math");
        const needsPro = isDrawableAny && (!!q.answerImageData || paperIsScienceOrMath);
        const QUIZ_MODELS = needsPro
          ? ["gemini-3.1-pro-preview"]
          // Non-drawable OEQ: start cheap, escalate on each retry.
          // The previous flash→flash→lite chain just hit the same
          // JSON-malformation bug three times in a row when 2.5-flash
          // got chatty mid-response. flash → 2.5-pro → 3.1-pro-preview
          // spends a little more on the rare retry path in exchange
          // for actually getting JSON back. Skipping gemini-3-flash-
          // preview as the middle step — its 504 rate has been too
          // high to be useful inside a marking loop.
          : ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview"];
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
                // responseMimeType forces Gemini to return valid JSON
                // instead of prose — eliminates the "no JSON, retrying"
                // path that was burning 5-15s of latency per OEQ when
                // flash got chatty. Other Gemini calls in this codebase
                // already use this; the marking call was missing it.
                config: {
                  temperature: needsPro ? 0 : 0.1,
                  responseMimeType: "application/json",
                },
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

              // SOURCE-OF-TRUTH: per-part breakdown (parts[]). When the
              // AI provides per-part awards, SUM them — bypasses the AI's
              // own top-level marksAwarded number, which historically
              // disagreed with its own per-part prose ("notes say -1 for
              // part (c), but total = 4/4"). Each part's award is clamped
              // to its declared max OR the corresponding partMaxMarks cap.
              // Empty / missing parts[] falls through to the legacy prose
              // reconciliation chain below.
              const partsBreakdown = Array.isArray(parsed.parts) ? parsed.parts : null;
              const usePartsSum = !!partsBreakdown && partsBreakdown.length > 0;
              if (usePartsSum) {
                let sum = 0;
                const trace: string[] = [];
                for (const p of partsBreakdown!) {
                  const label = String(p?.label ?? "").toLowerCase();
                  const rawAwarded = Math.max(0, Number(p?.awarded) || 0);
                  const declaredMax = Number(p?.max);
                  const knownMax = partMaxMarks.get(label);
                  const cap = Number.isFinite(declaredMax) && declaredMax > 0
                    ? Math.min(declaredMax, knownMax ?? declaredMax)
                    : (knownMax ?? marksAvailable);
                  const clamped = Math.min(rawAwarded, cap);
                  sum += clamped;
                  trace.push(`(${label})=${clamped}${clamped !== rawAwarded ? `[clamped from ${rawAwarded}, cap ${cap}]` : ""}`);
                }
                const newAwarded = Math.min(marksAvailable, sum);
                if (Math.abs(newAwarded - awarded) > 0.0001) {
                  console.log(`[quiz-marking] Q${q.questionNum} per-part sum overrides AI top-level: ${awarded} → ${newAwarded}/${marksAvailable} (${trace.join(", ")})`);
                } else {
                  console.log(`[quiz-marking] Q${q.questionNum} per-part sum: ${newAwarded}/${marksAvailable} (${trace.join(", ")})`);
                }
                awarded = newAwarded;
              }

              // Deterministic per-part SUM from the notes prose. This
              // overrides whatever marksAwarded the AI returned at the
              // top level — that number has repeatedly disagreed with
              // the per-part wording (Q9: top=3 with notes "Part (a):
              // 1, Part (b): 0"; Q10: top=0 with notes "Part (a): 1,
              // Part (b): 1"). The prompt asks the AI to write
              // "Part (x): … Awarded N mark(s)." for every part, so
              // we just parse those out and sum them server-side.
              // Triggers only when ≥2 per-part chunks each carry an
              // "Awarded N mark(s)" line — single-part questions and
              // headerless prose fall through to the parts[]/top-level
              // value already in `awarded`.
              if (parsed.notes) {
                const notesStr = String(parsed.notes);
                const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
                const partAwards: { label: string; awarded: number }[] = [];
                for (const m of notesStr.matchAll(partRe)) {
                  const label = m[1].toLowerCase();
                  const chunk = m[2];
                  const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
                  if (!awardMatch) continue;
                  partAwards.push({ label, awarded: parseFloat(awardMatch[1]) });
                }
                if (partAwards.length >= 2) {
                  const proseSum = partAwards.reduce((s, p) => {
                    const cap = partMaxMarks.get(p.label);
                    return s + (cap != null ? Math.min(cap, Math.max(0, p.awarded)) : Math.max(0, p.awarded));
                  }, 0);
                  const newAwarded = Math.min(marksAvailable, proseSum);
                  if (Math.abs(newAwarded - awarded) > 0.0001) {
                    console.log(`[quiz-marking] Q${q.questionNum} prose-sum override: ${awarded} → ${newAwarded}/${marksAvailable} (${partAwards.map(p => `(${p.label})=${p.awarded}`).join(", ")})`);
                  }
                  awarded = newAwarded;
                }
              }

              // Blank-subpart clamp. blankSubparts came from a
              // pixel-level inspection of the ink layer — it's a hard
              // physical fact that those parts had zero pen strokes.
              // Original failure mode: AI hallucinated marks on empty
              // canvases ("filled in A, B, C, D, E" with no ink ->
              // 2/2). But the blanket "zero any nonzero per-part mark
              // on a blank label" override has the opposite failure
              // mode: when the pixel check misfires on a part that
              // DID have ink (Q10's circuit diagram), it wipes valid
              // 1-mark / 0.5-mark scores. Tightened: only override a
              // per-part award when AI gave FULL marks for that part.
              // Conservative AI scores (<full) are kept — those are
              // already cautious so the only thing zeroing them would
              // do is bake in a pixel-check mistake.
              if (blankSubparts.size > 0 && awarded > 0) {
                const partsToZero = new Set<string>();
                if (usePartsSum && partsBreakdown) {
                  for (const p of partsBreakdown) {
                    const label = String(p?.label ?? "").toLowerCase();
                    if (!blankSubparts.has(label)) continue;
                    const rawAwarded = Math.max(0, Number(p?.awarded) || 0);
                    if (rawAwarded === 0) continue;
                    const declaredMax = Number(p?.max);
                    const knownMax = partMaxMarks.get(label);
                    const cap = Number.isFinite(declaredMax) && declaredMax > 0
                      ? Math.min(declaredMax, knownMax ?? declaredMax)
                      : (knownMax ?? marksAvailable);
                    if (rawAwarded >= cap - 0.0001) {
                      partsToZero.add(label);
                      console.log(`[quiz-marking] Q${q.questionNum} blank-subpart override: (${label}) AI awarded ${rawAwarded}/${cap} (full) but canvas blank → 0`);
                    } else {
                      console.log(`[quiz-marking] Q${q.questionNum} blank-subpart KEPT: (${label}) AI awarded ${rawAwarded}/${cap} (conservative) — pixel check disagrees but AI score is already cautious, trusting AI`);
                    }
                  }
                  if (partsToZero.size > 0) {
                    let resum = 0;
                    for (const p of partsBreakdown) {
                      const label = String(p?.label ?? "").toLowerCase();
                      if (partsToZero.has(label)) continue;
                      const rawAwarded = Math.max(0, Number(p?.awarded) || 0);
                      const declaredMax = Number(p?.max);
                      const knownMax = partMaxMarks.get(label);
                      const cap = Number.isFinite(declaredMax) && declaredMax > 0
                        ? Math.min(declaredMax, knownMax ?? declaredMax)
                        : (knownMax ?? marksAvailable);
                      resum += Math.min(rawAwarded, cap);
                    }
                    const newAwarded = Math.min(marksAvailable, resum);
                    console.log(`[quiz-marking] Q${q.questionNum} blank-subpart parts[] total: ${awarded} → ${newAwarded}/${marksAvailable}`);
                    awarded = newAwarded;
                  }
                }
                // Notes rewrite: only for parts we actually zeroed,
                // so the displayed prose stays in sync with stored
                // marks. Conservative parts we kept keep their original
                // "Awarded N mark(s)" text.
                if (partsToZero.size > 0 && parsed.notes) {
                  const notesStr = String(parsed.notes);
                  const partRe = /((?:^|[\n|])\s*(?:Part\s*)?\(?([a-z])\)\s*:?\s*)([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
                  let rewritten = notesStr;
                  for (const m of notesStr.matchAll(partRe)) {
                    const label = m[2].toLowerCase();
                    if (!partsToZero.has(label)) continue;
                    const replacement = ` The student left this part blank — confirmed by ink check. Awarded 0 mark(s).`;
                    rewritten = rewritten.replace(m[0], m[1] + replacement);
                  }
                  if (rewritten !== notesStr) parsed.notes = rewritten;
                }
              }

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
              console.log(`[quiz-marking] OEQ Q${q.questionNum} marked by ${model}: ${awarded}/${marksAvailable}`);
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
        // OpenAI fallback (the "4th attempt"): only fires when Gemini
        // exhausted its tries with a transient 5xx-class error. Pure
        // synonyms-disagree or parse failures aren't going to be helped
        // by a different vendor on the same image, so we don't burn an
        // OpenAI call on those — they fall straight through to the
        // unmarked write below.
        if (lastErr) {
          const fallbackParts = lastParseFailText
            ? [...markParts, { text: JSON_ONLY_REMINDER }]
            : markParts;
          const openaiResp = await tryOpenAIMarkingFallback(
            {
              model: QUIZ_MODELS[QUIZ_MODELS.length - 1],
              contents: [{ role: "user", parts: fallbackParts }],
              config: { temperature: needsPro ? 0 : 0.1, responseMimeType: "application/json" },
            },
            lastErr,
            `quiz-oeq-q${q.questionNum}`,
          );
          if (openaiResp) {
            const text = openaiResp.text?.trim() ?? "";
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]) as QuestionMarkResult;
                parsed.studentAnswer = detectedAnswer || parsed.studentAnswer;
                const awarded = Math.min(marksAvailable, Math.max(0, Number(parsed.marksAwarded) || 0));
                updates.push(
                  prisma.examQuestion.update({
                    where: { id: q.id },
                    data: {
                      marksAwarded: awarded,
                      studentAnswer: parsed.studentAnswer || null,
                      markingNotes: buildMarkingNotes({ ...parsed, questionId: q.id, marksAvailable, marksAwarded: awarded }),
                    },
                  }),
                );
                console.log(`[quiz-marking] OEQ Q${q.questionNum} marked by OpenAI fallback: ${awarded}/${marksAvailable}`);
                lastErr = null;
                lastParseFailText = null;
              } catch (err) {
                console.warn(`[quiz-marking] OEQ Q${q.questionNum} OpenAI fallback returned unparseable JSON:`, err);
              }
            } else {
              console.warn(`[quiz-marking] OEQ Q${q.questionNum} OpenAI fallback returned no JSON`);
            }
          }
        }
        if (lastErr) {
          console.error(`[quiz-marking] OEQ Q${q.questionNum} failed after ${QUIZ_MODELS.length} Gemini attempts (+ OpenAI fallback if applicable):`, lastErr);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              // Leave marksAwarded NULL so the end-of-marker unmarked
              // check catches this question and either triggers the
              // "complete with caveat" branch (≤2 unmarked) or fails
              // the whole paper (>2 unmarked).
              data: { marksAwarded: null, markingNotes: "Marking error — AI unavailable, please re-mark" },
            })
          );
        } else if (lastParseFailText !== null) {
          console.error(`[quiz-marking] OEQ Q${q.questionNum} all ${QUIZ_MODELS.length} attempts returned non-JSON; last response (truncated): ${lastParseFailText.slice(0, 200)}`);
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: null, markingNotes: "Failed to parse AI response after retries — please re-mark" },
            })
          );
        }
      })()));
    }

    // Commit per-question updates first so the verification pass below
    // sees the latest state, then derive score + status from that — never
    // from the in-memory totalAwarded counter, which silently drifted to
    // 0 on the Ruthie incident when OEQ updates were lost mid-transaction.
    if (updates.length > 0) await prisma.$transaction(updates);

    const finalState = await prisma.examQuestion.findMany({
      where: { examPaperId: paperId, marksAvailable: { not: null } },
      select: { id: true, questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true, studentAnswer: true },
    });

    // ── TABULATION SAFETY NET ──────────────────────────────────────
    // The OEQ marker has per-part-aware logic (parts[] sum, prose-sum
    // override, blank-subpart clamp, drawable clamp). Each layer fixes
    // one historical incident. But each layer has also, at one time
    // or another, silently overwritten a later one's correct verdict —
    // most recently on this paper:
    //   /exam/cmq34sx5b004qgnicjxy3flh6/review
    //   Q10 stored 0/4, markingNotes ended with "Part (b): … Awarded 1
    //   mark(s). Part (c): … Awarded 0 mark(s). Part (d): … Awarded 1
    //   mark(s)." — clear 0+1+0+1 = 2.
    //
    // The contract students/parents care about: the per-part marks in
    // the markingNotes ARE what counts. So before declaring the paper
    // complete, re-parse the notes for every question and re-sync
    // marksAwarded to the prose sum. This is a server-side belt-and-
    // suspenders pass over the in-loop prose-sum override — guaranteed
    // not to silently disagree even if a future change to the marker
    // breaks an earlier override.
    const tabFixes: { id: string; questionNum: string; before: number; after: number }[] = [];
    const tabUpdates: ReturnType<typeof prisma.examQuestion.update>[] = [];
    for (const q of finalState) {
      if (!q.markingNotes) continue;
      const marksAvailable = q.marksAvailable ?? 0;
      if (marksAvailable <= 0) continue;
      // Strip the "Detected: <student>" prefix that buildMarkingNotes
      // prepends so we don't pick up "(a)", "(b)" labels from the
      // student's own answer text.
      const sepIdx = q.markingNotes.indexOf(" | ");
      const notesStr = sepIdx >= 0 ? q.markingNotes.slice(sepIdx + 3) : q.markingNotes;
      const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
      const partAwards: { label: string; awarded: number }[] = [];
      for (const m of notesStr.matchAll(partRe)) {
        const chunk = m[2];
        const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
        if (!awardMatch) continue;
        partAwards.push({ label: m[1].toLowerCase(), awarded: parseFloat(awardMatch[1]) });
      }
      if (partAwards.length < 2) continue; // single-part / MCQ / no per-part prose — leave alone
      const proseSum = Math.min(marksAvailable, partAwards.reduce((s, p) => s + Math.max(0, p.awarded), 0));
      const stored = q.marksAwarded ?? 0;
      if (Math.abs(proseSum - stored) < 0.0001) continue;
      tabFixes.push({ id: q.id, questionNum: q.questionNum, before: stored, after: proseSum });
      tabUpdates.push(prisma.examQuestion.update({ where: { id: q.id }, data: { marksAwarded: proseSum } }));
      // Mutate in place so the finalScore reduce below sees the fix.
      q.marksAwarded = proseSum;
    }
    if (tabUpdates.length > 0) {
      console.warn(`[quiz-marking] Paper ${paperId} tabulation safety net resynced ${tabUpdates.length} question(s) from notes prose-sum: ${tabFixes.map(f => `Q${f.questionNum}: ${f.before}→${f.after}`).join(", ")}`);
      await prisma.$transaction(tabUpdates);
    }

    const finalScore = finalState.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    // A question is "unmarked" when the marker couldn't commit a verdict
    // (marksAwarded is null) or never produced a note, and the student
    // didn't explicitly skip it. The OEQ retry loops above now leave
    // marksAwarded NULL (rather than 0) on a real marker failure, so
    // this filter catches them cleanly.
    const unmarked = finalState.filter(q =>
      q.studentAnswer !== "__SKIPPED__" &&
      (q.marksAwarded == null || q.markingNotes == null)
    );
    // Three-way policy:
    //   0 unmarked → complete (existing).
    //   1-2 unmarked → complete but with a caveat prepended to the
    //     parent-facing feedbackSummary so they know which Qs need a
    //     manual review.
    //   3+ unmarked → genuine failure, mark the whole paper as failed
    //     so the dashboard surfaces the "re-mark" path.
    if (unmarked.length > MAX_UNMARKED_FOR_CAVEAT) {
      console.error(`[quiz-marking] Paper ${paperId} has ${unmarked.length} questions with no marking output: ${unmarked.map(q => `Q${q.questionNum}`).join(", ")} — marking as failed`);
      await prisma.examPaper.update({
        where: { id: paperId },
        data: { score: finalScore, markingStatus: "failed" },
      });
      return;
    }
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { score: finalScore, markingStatus: "complete" },
    });

    // Generate feedback
    await generateFeedbackSummary(paperId);

    // Prepend the "couldn't mark Q… — please review manually" caveat
    // AFTER generateFeedbackSummary writes its own text, so the parent
    // sees the warning at the very top of the summary card.
    await applyMarkingCaveat(paperId, unmarked);

    // Auto-release if 100% score and student has skipReviewPerfect enabled
    const totalAvailable = paper.questions.reduce((sum, q) => sum + (q.marksAvailable ?? 0), 0);
    if (totalAvailable > 0 && finalScore >= totalAvailable && paper.assignedToId) {
      const student = await prisma.user.findUnique({ where: { id: paper.assignedToId }, select: { settings: true } });
      const settings = (student?.settings ?? {}) as Record<string, unknown>;
      if (settings.skipReviewPerfect === true) {
        await prisma.examPaper.update({ where: { id: paperId }, data: { markingStatus: "released" } });
        console.log(`[quiz-marking] Paper ${paperId} auto-released (100% score, skipReviewPerfect=true)`);
      }
    }

    console.log(`[quiz-marking] Paper ${paperId} done. Score: ${finalScore}`);
  } catch (err) {
    const current = await prisma.examPaper.findUnique({
      where: { id: paperId }, select: { markingStatus: true },
    });
    if (current?.markingStatus === "complete" || current?.markingStatus === "released") {
      console.warn(`[quiz-marking] post-marking error suppressed for ${paperId} — status already "${current.markingStatus}":`, err);
      return;
    }
    console.error(`[quiz-marking] Failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
  }
}
