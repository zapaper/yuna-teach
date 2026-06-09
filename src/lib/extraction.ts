import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { prisma } from "@/lib/db";

// Canonical labels for Chinese paper sections. Gemini occasionally
// hallucinates an English translation for a Chinese section label
// (e.g. "Short Passage Cloze" instead of "短文填空", "Dialogue
// Completion" instead of "完成对话"). Both the section-rendering
// pathway and the per-section passage-attach gate match on the
// Chinese spelling, so an English label silently breaks the quiz and
// the audit. Normalise here on the read path so the downstream code
// only ever sees the canonical Chinese form.
const CHINESE_SECTION_NORMALISATION: Record<string, string> = {
  "Short Passage Cloze": "短文填空",
  "Passage Cloze": "短文填空",
  "Dialogue Completion": "完成对话",
  "Dialogue Cloze": "完成对话",
  "Chinese Language Application": "语文应用 MCQ",
  "Language Application MCQ": "语文应用 MCQ",
  "Comprehension MCQ": "阅读理解 MCQ",
  "Comprehension OEQ": "阅读理解 OEQ",
  "Comprehension A": "阅读理解 A",
  "Comprehension B OEQ": "阅读理解 B OEQ",
};
function normaliseChineseSectionLabel(label: string | null | undefined): string | null {
  if (!label) return label ?? null;
  return CHINESE_SECTION_NORMALISATION[label] ?? label;
}

// --- Extraction queue: run one extraction at a time to avoid Gemini rate limits ---
let extractionQueue: Array<{ paperId: string; resolve: () => void; reject: (e: unknown) => void }> = [];
let extractionRunning = false;

async function processQueue() {
  if (extractionRunning || extractionQueue.length === 0) return;
  extractionRunning = true;
  const { paperId, resolve, reject } = extractionQueue.shift()!;
  try {
    await extractExamPaperCore(paperId);
    resolve();
  } catch (e) {
    reject(e);
  } finally {
    extractionRunning = false;
    processQueue();
  }
}

/** Normalize level strings like "P6", "Primary Six", "Pri 6" → "Primary 6" */
export function normalizeLevel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Map word numbers to digits
  const wordToNum: Record<string, string> = {
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  };
  // Match patterns like P6, Pr6, Pr 6, Pri6, Pri 6, Primary 6, Primary Six, etc.
  const m = s.match(/^(?:p(?:r(?:i(?:mary)?)?)?)\s*(\w+)$/i);
  if (m) {
    const numPart = m[1].toLowerCase();
    const digit = wordToNum[numPart] ?? (/^[1-6]$/.test(numPart) ? numPart : null);
    if (digit) return `Primary ${digit}`;
  }
  return s;
}

/** Normalize subject strings to canonical form: "Mathematics", "Science", etc. */
export function normalizeSubject(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.includes("math")) return "Mathematics";
  if (s.includes("science")) return "Science";
  if (s.includes("english")) return "English";
  // Chinese / 华文 / 中文 / Mother Tongue (Chinese variant). Matches
  // both English and Chinese spellings so a paper's cover-page header
  // routes to the Chinese pathway regardless of which the user uploads.
  if (s.includes("chinese") || raw.includes("华文") || raw.includes("中文") || raw.includes("华语")) return "Chinese";
  // Return original casing for unknown subjects
  return raw.trim();
}

import {
  analyzeExamBatch,
  normalizeAnswer,
  getLastFallbackUsed,
  type AnswerEntry,
  type BatchAnalysisResult,
} from "@/lib/gemini";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// Coerce a marks-like value coming back from the AI to a number-or-null.
// The model sometimes emits `"2"` (string) instead of `2`, which Prisma
// then rejects on the Float column. Catches strings with stray "marks"
// suffixes (e.g. "2 marks" → 2) and falls back to null on garbage.
function coerceMarks(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Answer keys for English text-based sections sometimes include inline
// explanations that belong in the marking scheme, not in the answer
// the student should be checked against:
//   Comp Cloze:   "elated (= very happy)" / "elated — meaning excited"
//   Editing:      "Exhilaration | (This is a spelling error)"
//   Synthesis:    "Although it was raining, we went out. (concession)"
// Strip those so marking only sees the actual answer.
//
// `aggressive=true` (Comp Cloze, Editing) also drops trailing
// "= ..." / dash / punctuation tails that wouldn't appear in a
// legitimate one-word fill. Synthesis answers can be full sentences —
// for those, only the parentheticals and pipe-explanation come off.
function cleanAnswerKeyExplanation(answer: string, aggressive: boolean): string {
  if (!answer) return "";
  let s = answer.trim();
  // Pipe separator: "Exhilaration | (This is a spelling error)" → take
  // only the part before the first pipe.
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) s = s.slice(0, pipeIdx).trim();
  // Parentheticals (always safe to strip — those are explanations).
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (aggressive) {
    // Trailing "= ..." / em-dash / en-dash explanations.
    s = s.replace(/\s*[=—–]\s*.+$/, "").trim();
    s = s.replace(/\s+-\s+.+$/, "").trim();
    // Trailing punctuation that sometimes sneaks into one-word keys.
    s = s.replace(/[.!?;:,]+$/, "").trim();
  }
  return s;
}

export async function cropQuestionServer(
  imageBuffer: Buffer,
  yStartPct: number,
  yEndPct: number,
  topPadPct = 0.05,
  botPadPct = 0.02,
  xStartPct?: number,
  xEndPct?: number
): Promise<string> {
  const metadata = await sharp(imageBuffer).metadata();
  const height = metadata.height!;
  const width = metadata.width!;
  const topPad = Math.round(topPadPct * height);
  const botPad = Math.round(botPadPct * height);
  const top = Math.max(
    0,
    Math.floor((yStartPct / 100) * height) - topPad
  );
  const bottom = Math.min(
    height,
    Math.ceil((yEndPct / 100) * height) + botPad
  );
  const cropHeight = bottom - top;
  // X boundaries (optional — default full width)
  const left = xStartPct != null ? Math.max(0, Math.floor((xStartPct / 100) * width)) : 0;
  const right = xEndPct != null ? Math.min(width, Math.ceil((xEndPct / 100) * width)) : width;
  const cropWidth = right - left;
  if (cropHeight <= 0 || cropWidth <= 0) {
    // Fallback: return full image
    const buf = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  }
  const croppedBuffer = await sharp(imageBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`;
}

/** Stitch multiple page images vertically into one JPEG (for Visual Text context) */
async function stitchPagesVertically(pages: Buffer[]): Promise<Buffer> {
  if (pages.length === 0) return Buffer.alloc(0);
  if (pages.length === 1) return pages[0];
  const metas = await Promise.all(pages.map(p => sharp(p).metadata()));
  const maxW = Math.max(...metas.map(m => m.width ?? 0));
  const totalH = metas.reduce((sum, m) => sum + (m.height ?? 0), 0);
  const resized = await Promise.all(pages.map(p =>
    sharp(p).resize({ width: maxW, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer()
  ));
  const heights = await Promise.all(resized.map(async b => (await sharp(b).metadata()).height ?? 0));
  let yOff = 0;
  const composites = resized.map((buf, i) => {
    const c = { input: buf, top: yOff, left: 0 };
    yOff += heights[i];
    return c;
  });
  return sharp({ create: { width: maxW, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Split a multi-part answer string by sub-part labels.
 * Answer format: "(a) 24 cm² | (b) 15 cm | (c) 3.5 kg"
 * subParts: "ab" → "(a) 24 cm² | (b) 15 cm"
 * subParts: "c"  → "(c) 3.5 kg"
 *
 * Tolerates both `(a)` and `a)` forms of the label — parents type
 * the answer key in either style and the splitter was previously
 * silent-failing on "a) X | b) Y" because the regex required the
 * opening paren.
 */
function splitAnswerBySubParts(fullAnswer: string, subParts: string): string {
  if (!fullAnswer || !subParts) return "";
  const letters = subParts.split("");
  // Match `(a)` or `a)` — opening paren optional. Anchored either
  // at start-of-string or after whitespace / pipe so we don't
  // accidentally hit a stray "a)" in the middle of explanatory
  // prose (e.g. "Option a) above is wrong because…"). The pipe
  // marker is treated as a separator in this codebase.
  const partRegex = /(?:^|[\s|])\(?([a-z])\)\s*/gi;
  const parts: { label: string; text: string }[] = [];
  let match: RegExpExecArray | null;
  const positions: { label: string; start: number; contentStart: number }[] = [];

  while ((match = partRegex.exec(fullAnswer)) !== null) {
    positions.push({
      label: match[1].toLowerCase(),
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (positions.length === 0) {
    // No labeled parts found — if this is the first segment, return the whole answer
    return fullAnswer;
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : fullAnswer.length;
    const text = fullAnswer.slice(positions[i].start, end).trim();
    // Remove trailing " | " separator
    parts.push({ label: positions[i].label, text: text.replace(/\s*\|\s*$/, "") });
  }

  // Filter to only the parts in this segment's subParts
  const matched = parts.filter((p) => letters.includes(p.label));
  return matched.map((p) => p.text).join(" | ");
}

type BookletRange = {
  prefix: string;
  firstQuestionNum: number;
  lastQuestionNum: number;
  questionsStartPageIndex: number;
};

function buildBookletRanges(
  result: BatchAnalysisResult
): BookletRange[] {
  if (!result._debug?.papers) return [];
  const prefixCounts = new Map<string, number>();
  return result._debug.papers.map((p) => {
    const prevCount = prefixCounts.get(p.label) || 0;
    // Use questionPrefix from _debug if available
    const prefix = (p as Record<string, unknown>).questionPrefix as string || "";
    const prevPrefixCount = prefixCounts.get(prefix) || 0;
    const firstQ = prevPrefixCount + 1;
    const lastQ = prevPrefixCount + p.expectedQuestions;
    prefixCounts.set(prefix, lastQ);
    return {
      prefix,
      firstQuestionNum: firstQ,
      lastQuestionNum: lastQ,
      questionsStartPageIndex: p.questionsStartPage - 1,
    };
  });
}

function resolvePageIndex(
  questionNum: string,
  extractedPageIndex: number,
  prevQuestion: { pageIndex: number; yEndPct: number } | null,
  ranges: BookletRange[],
  pageCount: number,
  yStartPct?: number
): number {
  const printedNum = questionNum.replace(/^(P\d+-|B\d+-)/, "");
  const prefix = questionNum.replace(printedNum, "");
  const qNumInt = parseInt(printedNum, 10);
  if (isNaN(qNumInt) || ranges.length === 0) return extractedPageIndex;

  const booklet = ranges.find(
    (b) =>
      b.prefix === prefix &&
      qNumInt >= b.firstQuestionNum &&
      qNumInt <= b.lastQuestionNum
  );

  // If previous question ended at bottom of page (>=90%), move to next page.
  // But skip this correction if the current question starts near the top of its
  // reported page (yStartPct < 30%) — it genuinely belongs on that page.
  if (prevQuestion && prevQuestion.yEndPct >= 90) {
    const startsAtTop = yStartPct != null && yStartPct < 30;
    const nextPage = prevQuestion.pageIndex + 1;
    if (extractedPageIndex <= prevQuestion.pageIndex && nextPage < pageCount && !startsAtTop) {
      return nextPage;
    }
  }

  // If extracted page is before the previous question's page, use same page
  if (prevQuestion && extractedPageIndex < prevQuestion.pageIndex) {
    return prevQuestion.pageIndex;
  }

  // First question in a booklet always starts on questionsStartPage
  if (
    booklet &&
    qNumInt === booklet.firstQuestionNum &&
    extractedPageIndex !== booklet.questionsStartPageIndex
  ) {
    return booklet.questionsStartPageIndex;
  }

  // If extracted page is before booklet start, use booklet start
  if (booklet && extractedPageIndex < booklet.questionsStartPageIndex) {
    return booklet.questionsStartPageIndex;
  }

  return extractedPageIndex;
}

export function extractExamPaperBackground(paperId: string): Promise<void> {
  console.log(`[extraction] Queuing extraction for ${paperId} (queue length: ${extractionQueue.length})`);
  return new Promise<void>((resolve, reject) => {
    extractionQueue.push({ paperId, resolve, reject });
    processQueue();
  });
}

// Hard cap: if extraction hasn't completed in 10 minutes, fail loudly.
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;

async function extractExamPaperCore(
  paperId: string
): Promise<void> {
  console.log(`[extraction] Starting background extraction for ${paperId}`);

  const timeoutHandle = setTimeout(() => {
    console.error(`[extraction] TIMEOUT after ${EXTRACTION_TIMEOUT_MS / 1000}s for ${paperId} — marking as failed`);
    prisma.examPaper.update({ where: { id: paperId }, data: { extractionStatus: "failed" } }).catch(() => {});
  }, EXTRACTION_TIMEOUT_MS);

  try {
    // 1. Load page images from disk
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
    });
    if (!paper) throw new Error("Paper not found");

    const pagesDir = path.join(PAGES_DIR, paperId);
    const imageBuffers: Buffer[] = [];
    const imagesBase64: string[] = [];
    for (let i = 0; i < paper.pageCount; i++) {
      const buf = await fs.readFile(path.join(pagesDir, `page_${i}.jpg`));
      imageBuffers.push(buf);
      imagesBase64.push(buf.toString("base64"));
    }

    // 2. Run Gemini analysis
    const result = await analyzeExamBatch(imagesBase64);

    // 3. Build booklet ranges for page correction
    const ranges = buildBookletRanges(result);

    // Build set of paperLabels to skip (Writing / Listening Comprehension)
    const skipLabels = new Set(
      (result._debug?.papers ?? [])
        .filter(p => p.skipExtraction)
        .map(p => p.label)
    );

    // 4. For English / Chinese text-based extraction: skip image cropping entirely
    const detectedSubjectRaw = result.header?.subject || paper.subject || "";
    const detectedSubjectEarly = detectedSubjectRaw.toLowerCase();
    const isEnglishEarly = detectedSubjectEarly.includes("english");
    const isChineseEarly = detectedSubjectEarly.includes("chinese") || detectedSubjectRaw.includes("华文") || detectedSubjectRaw.includes("中文") || detectedSubjectRaw.includes("华语");
    const isTextBasedSubject = isEnglishEarly || isChineseEarly;
    const hasTextExtraction = isTextBasedSubject && result.pages.some(p =>
      p.questions.some(q => (q as { _stem?: string })._stem || (q as { _options?: string[] })._options)
    );

    // Pre-compute visual text pages for both text-based and image-based paths
    const visualTextPages: Buffer[] = [];
    if (isTextBasedSubject) {
      const vtQuestionPages = new Set<number>();
      const nonVtQuestionPages = new Set<number>();
      for (const page of result.pages) {
        for (const q of page.questions) {
          const topic = (q.syllabusTopic ?? result.syllabusTopics?.[q.questionNum] ?? "").toLowerCase();
          if (topic.includes("visual") && topic.includes("text")) vtQuestionPages.add(page.pageIndex);
          else nonVtQuestionPages.add(page.pageIndex);
        }
      }
      if (vtQuestionPages.size > 0) {
        const firstVtPage = Math.min(...vtQuestionPages);
        const lastNonVtPage = nonVtQuestionPages.size > 0 ? Math.max(...nonVtQuestionPages) : -1;
        for (let p = lastNonVtPage + 1; p < firstVtPage; p++) {
          if (!vtQuestionPages.has(p) && !nonVtQuestionPages.has(p) && imageBuffers[p]) {
            visualTextPages.push(imageBuffers[p]);
          }
        }
      }
    }

    if (hasTextExtraction) {
      const langLabel = isChineseEarly ? "Chinese" : "English";
      console.log(`[extraction] ${langLabel} text-based: building questions from OCR text (no image crops)`);
      const questions: Array<{
        questionNum: string; imageData: string; answer: string; answerImageData: string;
        pageIndex: number; orderIndex: number; yStartPct: number | null; yEndPct: number | null;
        marksAvailable: number | null; syllabusTopic: string | null;
        transcribedStem?: string; transcribedOptions?: string[];
      }> = [];

      for (const page of result.pages) {
        if (page.isAnswerSheet) continue;
        for (const q of page.questions) {
          const ext = q as { _stem?: string; _options?: string[]; _blankContext?: string; _errorWord?: string };
          const qNum = q.questionNum;
          // Get answer from answer extraction
          const rawEntry = result.answers?.[qNum];
          let answer = "";
          if (rawEntry) {
            const entry = normalizeAnswer(rawEntry);
            answer = entry.type === "text" ? entry.value : (entry.value || "");
          }

          // For Visual Text: store stitched visual page images
          let qImageData = "";
          const qTopic = (q.syllabusTopic ?? result.syllabusTopics?.[qNum] ?? "").toLowerCase();
          // Strip inline explanations from the answer key — see helper
          // comment for the formats this handles.
          if (answer) {
            const isCompCloze_ = qTopic.includes("comprehension") && qTopic.includes("cloze");
            const isSynth_ = qTopic.includes("synthesis");
            const isEditing_ = qTopic.includes("editing");
            if (isCompCloze_ || isSynth_ || isEditing_) {
              answer = cleanAnswerKeyExplanation(answer, isCompCloze_ || isEditing_);
            }
          }
          if (qTopic.includes("visual") && qTopic.includes("text") && visualTextPages.length > 0) {
            try {
              const stitched = await stitchPagesVertically(visualTextPages);
              qImageData = `data:image/jpeg;base64,${stitched.toString("base64")}`;
            } catch { /* ignore */ }
          }
          // Text-based extraction (English + Chinese) skips per-question
          // image crops. Grammar / vocab / synthesis MCQs are pure text;
          // long OEQs that genuinely need a picture (Visual Text,
          // 短信 diagrams, etc.) either come through the dedicated VTC
          // stitched-image branch above OR are uploaded by the admin via
          // /edit's Upload Image button. Auto-cropping every question
          // clutters the question list with screenshots no one needs.

          questions.push({
            questionNum: qNum,
            imageData: qImageData,
            answer,
            answerImageData: "",
            pageIndex: page.pageIndex,
            orderIndex: questions.length,
            yStartPct: q.yStartPct ?? null,
            yEndPct: q.yEndPct ?? null,
            marksAvailable: coerceMarks(q.marksAvailable ?? result.marksPerQuestion?.[qNum]),
            syllabusTopic: (() => {
              const t = q.syllabusTopic ?? result.syllabusTopics?.[qNum] ?? null;
              return isChineseEarly ? normaliseChineseSectionLabel(t) : t;
            })(),
            transcribedStem: ext._stem || ext._blankContext || ext._errorWord || undefined,
            transcribedOptions: ext._options || undefined,
          });
        }
      }

      // Sort questions by question number to maintain paper order.
      //
      // Strip leading prefixes that Gemini occasionally injects:
      //   "P2-15"  → strip "P2-" → "15"   (booklet prefix with separator)
      //   "Q30"    → strip "Q"   → "30"   (bare Q prefix)
      //   "QQ30"   → strip "QQ"  → "30"   (doubled Q from missing-retry path)
      //   "15"     → unchanged   → "15"
      //   "3a"     → unchanged   → "3a"
      //   "QP2-12a" → strip "QP2-" → "12a"
      // The previous one-line regex `^[A-Za-z]+\d*[-:_]?` was greedy and
      // ate "Q30" → "" → fell back to original. Result: "Q30"/"QQ30"
      // questions parsed as NaN, sorted to orderIndex 0, formed a ghost
      // section at the top of the question list (observed on PSLE 2019
      // Chinese 阅读理解 MCQ Q30-Q32). Split into two passes: separator-
      // anchored booklet prefix first, then bare Q-runs that precede a
      // digit (so legitimate "Qa" wouldn't be touched).
      const stripPrefix = (qn: string) => {
        let s = qn.replace(/^[A-Za-z]+\d*[-:_]/, ""); // "P2-", "B-", etc.
        s = s.replace(/^Q+(?=\d)/i, "");              // "Q30", "QQ30" → digits
        return s.trim() || qn;
      };
      for (const q of questions) q.questionNum = stripPrefix(q.questionNum);
      questions.sort((a, b) => {
        const aNum = parseInt(a.questionNum, 10);
        const bNum = parseInt(b.questionNum, 10);
        return (aNum || 0) - (bNum || 0);
      });

      // Save
      const debugMetadata = result._debug ? (() => { const { rawResponses: _ignored, ...rest } = result._debug!; return rest; })() : null;
      const sectionOcrTexts = result.sectionOcrTexts ?? null;
      const vocabClozePassageImage: string | null = null; // TODO: extract if needed

      // For Chinese papers, build `chineseSections` metadata so the
      // quiz UI (ChineseQuizSection) and the AI marker get the
      // section grouping + per-section passage they expect. Without
      // this the quiz falls back to flat MCQ rendering and the
      // typed OEQ + dialogue + inline-options sections silently
      // disappear.
      const chineseSections = isChineseEarly
        ? buildChineseSections(questions, sectionOcrTexts)
        : null;

      await prisma.$transaction([
        prisma.examQuestion.deleteMany({ where: { examPaperId: paperId } }),
        ...questions.map((q, i) =>
          prisma.examQuestion.create({
            data: {
              questionNum: q.questionNum,
              imageData: q.imageData,
              answer: q.answer || null,
              answerImageData: q.answerImageData || null,
              pageIndex: q.pageIndex,
              orderIndex: i,
              yStartPct: q.yStartPct,
              yEndPct: q.yEndPct,
              marksAvailable: q.marksAvailable,
              syllabusTopic: q.syllabusTopic,
              examPaperId: paperId,
              transcribedStem: q.transcribedStem ?? null,
              transcribedOptions: q.transcribedOptions ?? undefined,
            },
          })
        ),
        prisma.examPaper.update({
          where: { id: paperId },
          data: {
            title: result.header?.title || paper.title,
            school: result.header?.school || paper.school,
            level: normalizeLevel(result.header?.level) || paper.level,
            subject: normalizeSubject(result.header?.subject) || paper.subject,
            year: result.header?.year != null ? String(result.header.year) : paper.year,
            semester: result.header?.semester != null ? String(result.header.semester) : paper.semester,
            totalMarks: result.header?.totalMarks != null ? String(result.header.totalMarks) : paper.totalMarks,
            examType: result.header?.examType || paper.examType,
            metadata: {
              ...(debugMetadata as object ?? {}),
              ...(sectionOcrTexts ? { sectionOcrTexts } : {}),
              ...(vocabClozePassageImage ? { vocabClozePassageImage } : {}),
              ...(chineseSections ? { chineseSections } : {}),
            },
            extractionStatus: "ready",
          },
        }),
      ]);

      console.log(`[extraction] ${langLabel} text-based: ${questions.length} questions saved.`);
      if (chineseSections) {
        console.log(`[extraction] chineseSections: ${chineseSections.map(s => `${s.label}[${s.startIndex}-${s.endIndex}]${s.passage ? "+passage" : ""}`).join(", ")}`);
      }
      // Fire-and-forget AI audit of the freshly extracted Q&A
      import("@/lib/audit-qa").then(m => m.auditPaper(paperId).catch(e => console.error(`[extraction] auditPaper failed:`, e)));
      // Fire-and-forget difficulty classification (see main-path hook below).
      import("@/lib/difficulty-classify").then(m => m.classifyPaperDifficulty(paperId).catch(e => console.error(`[extraction] classifyPaperDifficulty failed:`, e)));
      // Fire-and-forget master-class subTopic tagging — assigns each
      // question to a sub-topic bucket for every master class whose
      // taxonomy applies (matches by syllabusTopic). Without this,
      // newly-uploaded papers' questions stay invisible to mastery
      // quizzes for the "default" master classes that need admin-
      // tagged subTopics.
      import("@/lib/master-class/classify-by-ai").then(m => m.classifyPaperSubtopics(paperId).catch(e => console.error(`[extraction] classifyPaperSubtopics failed:`, e)));
      return;
    }

    // 4. Collect all question segments (including multi-page continuations) — image-based path
    type QuestionSegment = {
      questionNum: string;
      pageIndex: number;
      yStartPct: number;
      yEndPct: number;
      xStartPct?: number;
      xEndPct?: number;
      isContinuation: boolean;
      subParts: string;
      _stem?: string;
      _options?: string[];
      _blankContext?: string;
      _errorWord?: string;
    };

    const allSegments: QuestionSegment[] = [];
    let lastCroppedQuestion: {
      pageIndex: number;
      yEndPct: number;
    } | null = null;

    for (const page of result.pages) {
      if (page.isAnswerSheet) continue;
      if (skipLabels.size > 0 && page.paperLabel && skipLabels.has(page.paperLabel)) continue;

      for (const q of page.questions) {
        const isCont = !!(q as { isContinuation?: boolean }).isContinuation;
        const subParts = ((q as { subParts?: string }).subParts ?? "").toLowerCase();
        const correctPageIndex: number = isCont
          ? page.pageIndex // continuations use their own page directly
          : resolvePageIndex(
              q.questionNum,
              page.pageIndex,
              lastCroppedQuestion,
              ranges,
              paper.pageCount,
              q.yStartPct
            );

        allSegments.push({
          questionNum: q.questionNum,
          pageIndex: correctPageIndex,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          xStartPct: (q as { xStartPct?: number }).xStartPct,
          xEndPct: (q as { xEndPct?: number }).xEndPct,
          isContinuation: isCont,
          subParts,
          // English text content from OCR extraction
          _stem: (q as { _stem?: string })._stem,
          _options: (q as { _options?: string[] })._options,
          _blankContext: (q as { _blankContext?: string })._blankContext,
          _errorWord: (q as { _errorWord?: string })._errorWord,
        });

        lastCroppedQuestion = {
          pageIndex: correctPageIndex,
          yEndPct: q.yEndPct,
        };
      }
    }

    // Group segments by questionNum, preserving order
    const questionGroups = new Map<string, QuestionSegment[]>();
    const questionOrder: string[] = [];
    for (const seg of allSegments) {
      if (!questionGroups.has(seg.questionNum)) {
        questionGroups.set(seg.questionNum, []);
        questionOrder.push(seg.questionNum);
      }
      questionGroups.get(seg.questionNum)!.push(seg);
    }

    const detectedSubjectRawImg = result.header?.subject || paper.subject || "";
    const detectedSubject = detectedSubjectRawImg.toLowerCase();
    const isEnglish = detectedSubject.includes("english");
    const isChinese = detectedSubject.includes("chinese") || detectedSubjectRawImg.includes("华文") || detectedSubjectRawImg.includes("中文") || detectedSubjectRawImg.includes("华语");

    // MCQ topics — used to tighten the top padding so answer options
    // aren't clipped. Chinese MCQ section names live alongside the
    // English ones; the padding rules in the body below apply when a
    // question's syllabusTopic matches any entry in this set.
    const ENGLISH_MCQ_TOPICS = new Set([
      "Grammar MCQ", "Vocabulary MCQ", "Vocabulary Cloze MCQ", "Visual Text Comprehension MCQ",
      "语文应用 MCQ", "短文填空", "阅读理解 MCQ", "完成对话",
    ]);

    // For Visual Text Comprehension (image-based path): reuse pre-computed visualTextPages or rebuild
    // visualTextPages was already computed above for the text-based path
    if (visualTextPages.length === 0 && isEnglish) {
      // Find which pages have Visual Text questions
      const vtQuestionPages = new Set<number>();
      const nonVtQuestionPages = new Set<number>();
      for (const seg of allSegments) {
        const topic = result.syllabusTopics?.[seg.questionNum] ?? null;
        if (topic === "Visual Text Comprehension MCQ") {
          vtQuestionPages.add(seg.pageIndex);
        } else {
          nonVtQuestionPages.add(seg.pageIndex);
        }
      }
      // Pages that have no questions at all but are between the last non-VT page and first VT page
      if (vtQuestionPages.size > 0) {
        const firstVtPage = Math.min(...vtQuestionPages);
        const lastNonVtPage = nonVtQuestionPages.size > 0 ? Math.max(...nonVtQuestionPages) : -1;
        for (let p = lastNonVtPage + 1; p < firstVtPage; p++) {
          if (!vtQuestionPages.has(p) && !nonVtQuestionPages.has(p) && imageBuffers[p]) {
            visualTextPages.push(imageBuffers[p]);
          }
        }
        console.log(`[extraction] Visual Text context pages: ${visualTextPages.length} pages between page ${lastNonVtPage + 1} and ${firstVtPage}`);
      }
    }

    // For Vocab Cloze MCQ: extract the passage (top half of the page) as a separate image
    let vocabClozePassageImage: string | null = null;
    if (isEnglish) {
      // Find the first Vocab Cloze MCQ question to get its page and yStartPct
      for (const seg of allSegments) {
        const topic = result.syllabusTopics?.[seg.questionNum] ?? null;
        if (topic === "Vocabulary Cloze MCQ" && !seg.isContinuation) {
          // Crop from top of page to just above the first question
          try {
            vocabClozePassageImage = await cropQuestionServer(
              imageBuffers[seg.pageIndex],
              0,
              Math.max(5, seg.yStartPct - 1),
              0, 0
            );
            console.log(`[extraction] Vocab Cloze passage extracted from page ${seg.pageIndex + 1}, 0%-${(seg.yStartPct - 1).toFixed(1)}%`);
          } catch (err) {
            console.warn(`[extraction] Failed to extract Vocab Cloze passage:`, err);
          }
          break;
        }
      }
    }

    // Process each question group
    const questions: Array<{
      questionNum: string;
      imageData: string;
      answer: string;
      answerImageData: string;
      pageIndex: number;
      orderIndex: number;
      yStartPct: number | null;
      yEndPct: number | null;
      marksAvailable: number | null;
      syllabusTopic: string | null;
    }> = [];

    for (const qNum of questionOrder) {
      const segments = questionGroups.get(qNum)!;

      // Normalise on the Chinese path so that downstream code never
      // sees an English-translated section label (Gemini sometimes
      // hallucinates "Short Passage Cloze" / "Dialogue Completion"
      // etc.). English / math / science topics pass through untouched.
      const rawTopic = result.syllabusTopics?.[qNum] ?? null;
      const syllabusTopic = isChinese ? normaliseChineseSectionLabel(rawTopic) : rawTopic;
      const isEnglishMcq = isEnglish && ENGLISH_MCQ_TOPICS.has(syllabusTopic ?? "");
      const isGrammarCloze = syllabusTopic === "Grammar Cloze";
      const isEditing = syllabusTopic === "Editing (Spelling & Grammar)";
      const isCompCloze = syllabusTopic === "Comprehension Cloze";
      // English padding per section type:
      // - MCQ: 0% top, 3% bottom
      // - Grammar Cloze: 3% top, 2% bottom
      // - Editing: 3% top, 3% bottom
      // - Comprehension Cloze: 3% top, 2% bottom
      // - Other English (S&T, OEQ): 0% top, 0% bottom
      // Other subjects: standard padding
      const topPadPct = isEnglish
        ? (isGrammarCloze || isEditing || isCompCloze ? 0.03 : 0)
        : 0.05;
      const isSynthesis = syllabusTopic === "Synthesis & Transformation";
      const isCompOEQ = syllabusTopic === "Comprehension (Open-ended)";
      // Grammar MCQ Q1 gets extra 5% bottom padding (first question often misdetected from preamble)
      const isFirstGrammarMcq = syllabusTopic === "Grammar MCQ" && (qNum === "1" || qNum.endsWith("-1"));
      const botPadPct = isEnglish
        ? (isFirstGrammarMcq ? 0.05 : isEditing ? 0.03 : isEnglishMcq ? 0.03 : isGrammarCloze || isCompCloze ? 0.02 : isSynthesis || isCompOEQ ? 0.005 : 0)
        : 0.02;

      // Get full answer for this question number
      const rawEntry = result.answers?.[qNum];
      let fullAnswer = "";
      let answerImageData = "";
      if (rawEntry) {
        const entry: AnswerEntry = normalizeAnswer(rawEntry);
        if (entry.type === "text") {
          fullAnswer = entry.value;
        } else if (entry.type === "image") {
          fullAnswer = entry.value || "";
          if (imageBuffers[entry.answerPageIndex]) {
            answerImageData = await cropQuestionServer(
              imageBuffers[entry.answerPageIndex],
              entry.yStartPct,
              entry.yEndPct
            );
          }
        }
      }
      // Strip inline explanations from the answer key — Comp Cloze /
      // Editing / Synthesis answer keys sometimes carry "(explanation)"
      // or "| explanation" tails that belong in the marking scheme,
      // not in the student-facing answer.
      if (fullAnswer) {
        if (isCompCloze || isSynthesis || isEditing) {
          fullAnswer = cleanAnswerKeyExplanation(fullAnswer, isCompCloze || isEditing);
        }
      }

      // Multi-page: split into separate questions per page segment
      if (segments.length > 1) {
        for (let si = 0; si < segments.length; si++) {
          const seg = segments[si];
          const croppedImage = await cropQuestionServer(
            imageBuffers[seg.pageIndex],
            seg.yStartPct,
            seg.yEndPct,
            topPadPct,
            botPadPct,
            seg.xStartPct,
            seg.xEndPct
          );
          // Build label: e.g. "39ab", "39cd". If no subParts, use page position
          const suffix = seg.subParts || (si === 0 ? "" : `_p${si + 1}`);
          const segQNum = suffix ? `${qNum}${suffix}` : qNum;

          // Split the text answer by sub-part labels for this segment
          const segAnswer = seg.subParts
            ? splitAnswerBySubParts(fullAnswer, seg.subParts)
            : (si === 0 ? fullAnswer : "");

          questions.push({
            questionNum: segQNum,
            imageData: croppedImage,
            answer: segAnswer,
            answerImageData: si === 0 ? answerImageData : "",
            pageIndex: seg.pageIndex,
            orderIndex: questions.length,
            yStartPct: seg.yStartPct ?? null,
            yEndPct: seg.yEndPct ?? null,
            marksAvailable: si === 0
              ? (result.marksPerQuestion?.[qNum] ?? null)
              : null,
            syllabusTopic: isChinese
              ? normaliseChineseSectionLabel(result.syllabusTopics?.[qNum] ?? null)
              : (result.syllabusTopics?.[qNum] ?? null),
          });
        }
        continue;
      }

      // Check for text content from English extraction (no image crop needed)
      const seg0 = segments[0] as { _stem?: string; _options?: string[]; _blankContext?: string; _errorWord?: string };
      const isVisualTextMcq = syllabusTopic === "Visual Text Comprehension MCQ";

      let croppedImage = "";
      if (isEnglish && !isVisualTextMcq) {
        // English non-VT: never crop. Grammar / vocab / synthesis / cloze /
        // editing / comp-OEQ are text-only — even when stem extraction
        // failed and seg0._stem is empty, an image crop is the wrong
        // fallback (it's just a screenshot of the page region). Admin
        // fills missing text via the transcribe-edit page.
        croppedImage = "";
      } else if (isEnglish && isVisualTextMcq) {
        // Visual Text Comprehension: stitched picture pages are the
        // payload, not a per-question crop.
        if (visualTextPages.length > 0) {
          try {
            const stitched = await stitchPagesVertically(visualTextPages);
            croppedImage = `data:image/jpeg;base64,${stitched.toString("base64")}`;
          } catch {
            croppedImage = "";
          }
        }
      } else {
        // Standard image crop
        croppedImage = await cropQuestionServer(
          imageBuffers[segments[0].pageIndex],
          segments[0].yStartPct,
          segments[0].yEndPct,
          topPadPct,
          botPadPct,
          segments[0].xStartPct,
          segments[0].xEndPct
        );

        // For Visual Text Comprehension: stitch visual text pages on top of question crop
        if (syllabusTopic === "Visual Text Comprehension MCQ" && visualTextPages.length > 0) {
          try {
            const cropBuf = Buffer.from(croppedImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
            const stitched = await stitchPagesVertically([...visualTextPages, cropBuf]);
            croppedImage = `data:image/jpeg;base64,${stitched.toString("base64")}`;
          } catch (err) {
            console.warn(`[extraction] Failed to stitch visual text pages for Q${qNum}:`, err);
          }
        }
      }

      const primary = segments[0];
      questions.push({
        questionNum: qNum,
        imageData: croppedImage,
        answer: fullAnswer,
        answerImageData,
        pageIndex: primary.pageIndex,
        orderIndex: questions.length,
        yStartPct: primary.yStartPct ?? null,
        yEndPct: primary.yEndPct ?? null,
        marksAvailable: coerceMarks(result.marksPerQuestion?.[qNum]),
        syllabusTopic: isChinese
          ? normaliseChineseSectionLabel(result.syllabusTopics?.[qNum] ?? null)
          : (result.syllabusTopics?.[qNum] ?? null),
        // English text content — store as transcribed fields for clean display
        ...(seg0._stem ? { transcribedStem: seg0._stem } : {}),
        ...(seg0._options ? { transcribedOptions: seg0._options } : {}),
        ...(seg0._blankContext ? { transcribedStem: seg0._blankContext } : {}),
        ...(seg0._errorWord ? { transcribedStem: seg0._errorWord } : {}),
      });
    }

    // 5. Build metadata to save
    const debugMetadata = result._debug
      ? (() => {
          const { rawResponses: _ignored, ...rest } = result._debug;
          return rest;
        })()
      : null;

    // Collect section OCR texts for English papers
    const sectionOcrTexts = result.sectionOcrTexts ?? null;

    // Per-question extraction can return segments out of paper order (e.g.
    // Q9 arriving after Q10). Sort by (pageIndex, numeric questionNum, suffix)
    // before persisting so orderIndex matches the real paper order — otherwise
    // a late-arriving Q9 ends up last in the UI.
    questions.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      const stripPrefix = (n: string) => n.replace(/^[A-Z]\d*-/, "");
      const aNum = stripPrefix(a.questionNum);
      const bNum = stripPrefix(b.questionNum);
      const aBase = parseInt(aNum, 10) || 0;
      const bBase = parseInt(bNum, 10) || 0;
      if (aBase !== bBase) return aBase - bBase;
      // Same base — preserve suffix order (e.g. 9a before 9b, 9 before 9a)
      return aNum.localeCompare(bNum, undefined, { numeric: true });
    });

    // 6. Save questions + update paper in a transaction
    await prisma.$transaction([
      // Delete any existing questions (in case of retry)
      prisma.examQuestion.deleteMany({ where: { examPaperId: paperId } }),
      // Create all questions
      ...questions.map((q, i) =>
        prisma.examQuestion.create({
          data: {
            questionNum: q.questionNum,
            imageData: q.imageData,
            answer: q.answer || null,
            answerImageData: q.answerImageData || null,
            pageIndex: q.pageIndex,
            orderIndex: i,
            yStartPct: q.yStartPct,
            yEndPct: q.yEndPct,
            marksAvailable: q.marksAvailable,
            syllabusTopic: q.syllabusTopic,
            examPaperId: paperId,
            // English text content from OCR extraction
            transcribedStem: (q as { transcribedStem?: string }).transcribedStem ?? null,
            transcribedOptions: (q as { transcribedOptions?: string[] }).transcribedOptions ?? undefined,
          },
        })
      ),
      // Update paper with extracted info
      prisma.examPaper.update({
        where: { id: paperId },
        data: {
          title: result.header?.title || paper.title,
          school: result.header?.school || paper.school,
          level: normalizeLevel(result.header?.level) || paper.level,
          subject: normalizeSubject(result.header?.subject) || paper.subject,
          year: result.header?.year != null ? String(result.header.year) : paper.year,
          semester: result.header?.semester != null ? String(result.header.semester) : paper.semester,
          totalMarks: result.header?.totalMarks != null ? String(result.header.totalMarks) : paper.totalMarks,
          examType: result.header?.examType || paper.examType,
          metadata: {
            ...(debugMetadata as object ?? {}),
            ...(vocabClozePassageImage ? { vocabClozePassageImage } : {}),
            ...(sectionOcrTexts ? { sectionOcrTexts } : {}),
            ...(() => { const fb = getLastFallbackUsed(); return fb ? { fallbackModelUsed: fb } : {}; })(),
          },
          extractionStatus: "ready",
        },
      }),
    ]);

    console.log(
      `[extraction] Paper ${paperId} done. ${questions.length} questions extracted.`
    );
    // Fire-and-forget AI audit (English/Science) — flags suspicious Q&A so the
    // edit view can highlight them in red. Skipped for other subjects.
    import("@/lib/audit-qa").then(m => m.auditPaper(paperId).catch(e => console.error(`[extraction] auditPaper failed:`, e)));
    // Fire-and-forget difficulty classification — tags each question 1-5 in
    // batches of 5 so newly uploaded papers come pre-labelled. Non-blocking,
    // runs after extractionStatus is already "ready".
    import("@/lib/difficulty-classify").then(m => m.classifyPaperDifficulty(paperId).catch(e => console.error(`[extraction] classifyPaperDifficulty failed:`, e)));
    // Fire-and-forget master-class subTopic tagging (see text-based path
    // above for rationale).
    import("@/lib/master-class/classify-by-ai").then(m => m.classifyPaperSubtopics(paperId).catch(e => console.error(`[extraction] classifyPaperSubtopics failed:`, e)));
  } catch (err) {
    console.error(`[extraction] Failed for ${paperId}:`, err);
    await prisma.examPaper
      .update({
        where: { id: paperId },
        data: { extractionStatus: "failed" },
      })
      .catch(() => {});
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Build the chineseSections metadata array from the extracted questions
// and per-section OCR data. The quiz and review UI both key off this
// array to enable the specialised Chinese section layouts:
//   - 短文填空           → inline 4-option pickers inside the passage
//   - 阅读理解 MCQ       → side-by-side passage + MCQ buttons
//   - 阅读理解 OEQ       → side-by-side passage + 田字格 canvas
//   - 完成对话           → word-bank table + dialogue with numbered blanks
//   - 语文应用 MCQ       → standalone MCQ cards (no passage)
//
// Grouping rule: consecutive questions sharing the same syllabusTopic
// form ONE section. For "阅读理解 MCQ" / "阅读理解 OEQ" we further
// split on pageIndex change since PSLE 五-A and 五-B each get their
// own passage. Each section's `passage` is sourced from
// sectionOcrTexts using the OCR key that matches the section's page
// (the per-section OCR step appends a "(pp<start>-<end>)" suffix when
// two sections share a name).
export type BuiltSection = { label: string; startIndex: number; endIndex: number; passage?: string };
export type QForGrouping = { pageIndex: number; syllabusTopic: string | null };
export type OcrEntry = { ocrText?: string; passageOcrText?: string; pageIndices?: number[]; passagePageIndices?: number[] };
export function buildChineseSections(
  questions: QForGrouping[],
  sectionOcrTexts: Record<string, OcrEntry> | null,
): BuiltSection[] {
  if (questions.length === 0) return [];

  // 1. Group consecutive questions with the same syllabusTopic. For
  //    阅读理解 sections, also split on a pageIndex change so 五-A
  //    (MCQ on page N) and 五-B (OEQ on page M) end up as distinct
  //    entries.
  const sections: BuiltSection[] = [];
  let curLabel = "";
  let curStart = -1;
  let curBoundaryPage = -1;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    // Apply the same normalisation here as a belt-and-suspenders pass
    // — if for any reason a question slipped through with an English
    // section label (rebuilt from a stale clone, hand-edited, etc.),
    // we still bucket it into the canonical Chinese section.
    const rawLabel = (q.syllabusTopic ?? "").trim();
    const label = normaliseChineseSectionLabel(rawLabel) ?? rawLabel;
    const isCompSec = label.includes("阅读理解");
    const boundaryPage = isCompSec ? q.pageIndex : -1;
    const startsNew = label !== curLabel || boundaryPage !== curBoundaryPage;
    if (startsNew && curStart >= 0) {
      sections.push({ label: curLabel, startIndex: curStart, endIndex: i - 1 });
    }
    if (startsNew) {
      curLabel = label;
      curStart = i;
      curBoundaryPage = boundaryPage;
    }
  }
  if (curStart >= 0) {
    sections.push({ label: curLabel, startIndex: curStart, endIndex: questions.length - 1 });
  }

  // 2. Attach `passage` from sectionOcrTexts. Each section's passage
  //    source depends on its label:
  //      - 阅读理解 (MCQ or OEQ): the standalone passageOcrText, or
  //        the previous comp-section's passage when 五-A's OEQ
  //        reuses the MCQ passage.
  //      - 完成对话 / 短文填空: ocrText (carries the dialogue / cloze
  //        passage inline).
  //      - 语文应用 MCQ: no passage.
  if (!sectionOcrTexts) return sections;
  const ocr = sectionOcrTexts;
  const ocrKeys = Object.keys(ocr);
  function findOcrKey(label: string, pages: Set<number>): string | null {
    // Prefer a (pp<a>-<b>) suffixed key whose range overlaps the section's pages.
    // The suffix is written from raw pageIndices (already 0-based), so no
    // conversion is needed — see ocrTexts key construction in lib/gemini.ts.
    const suffixed = ocrKeys.filter(k => k.startsWith(label + " (pp"));
    for (const k of suffixed) {
      const m = k.match(/\(pp(\d+)-(\d+)\)$/);
      if (!m) continue;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      for (let p = a; p <= b; p++) if (pages.has(p)) return k;
    }
    // Else any key with overlapping pageIndices (covers both the
    // exact-label case and unsuffixed first-encounter case).
    for (const k of ocrKeys) {
      if (k !== label && !k.startsWith(label + " (")) continue;
      const entry = ocr[k];
      if (!entry?.pageIndices) continue;
      if (entry.pageIndices.some(p => pages.has(p))) return k;
    }
    // Last-resort: exact label match regardless of pages.
    if (ocrKeys.includes(label)) return label;
    return null;
  }
  // Track each 阅读理解 section's passage PAGE indices so step 3 can
  // merge by passage source, not by passage string. The OCR step
  // sometimes re-OCRs the same physical page (e.g. 五-A's MCQ
  // passage and 五-A's OEQ passage both come from page 10) and the
  // two calls return slightly different text — a string-equality
  // merge fails to combine them. Page indices are stable.
  const secPassagePages = new Map<BuiltSection, Set<number>>();
  let lastCompPassage: string | undefined;
  let lastCompPages: Set<number> | undefined;
  let lastCompPassagePages: Set<number> | undefined;
  for (const sec of sections) {
    const pages = new Set<number>();
    for (let i = sec.startIndex; i <= sec.endIndex; i++) pages.add(questions[i].pageIndex);
    const key = findOcrKey(sec.label, pages);
    const entry = key ? ocr[key] : null;
    if (sec.label.includes("阅读理解")) {
      const p = entry?.passageOcrText;
      const ppi = entry?.passagePageIndices;
      if (p) {
        sec.passage = p;
        lastCompPassage = p;
        lastCompPages = pages;
        if (ppi && ppi.length > 0) {
          lastCompPassagePages = new Set(ppi);
          secPassagePages.set(sec, new Set(ppi));
        }
      } else if (lastCompPassage && lastCompPages) {
        // No own passage — borrow the previous comp section's passage
        // when the question pages are adjacent (within 1). Covers
        // older Chinese extractions where 五-A's OEQ has no passage
        // step at all.
        const minPrev = Math.min(...lastCompPages);
        const maxPrev = Math.max(...lastCompPages);
        const minThis = Math.min(...pages);
        const maxThis = Math.max(...pages);
        const adjacent = (minThis - maxPrev <= 1 && minThis - maxPrev >= 0) || (minPrev - maxThis <= 1 && minPrev - maxThis >= 0);
        if (adjacent) {
          sec.passage = lastCompPassage;
          if (lastCompPassagePages) secPassagePages.set(sec, new Set(lastCompPassagePages));
        }
      }
    } else if (sec.label.includes("短文填空") || sec.label.includes("完成对话") || sec.label.includes("对话填空")) {
      sec.passage = entry?.ocrText;
    }
    // 语文应用 MCQ / Visual Text MCQ: no passage attached.
  }

  // 3. PSLE 阅读理解二 grouping. The user-facing layout merges
  //    consecutive 阅读理解 sections that share the same passage
  //    (e.g. 五-A's MCQ Q30-32 + 五-A's OEQ Q33, which sit on the
  //    same reading passage) into ONE section, and labels passage A
  //    / passage B as "阅读理解A" / "阅读理解B" when 阅读理解二
  //    splits into multiple sub-passages. A solitary 阅读理解 group
  //    (e.g. section 三 阅读理解一 with only Q21-25) keeps its
  //    original label so we don't rename a section that has no peer.
  const grouped: BuiltSection[] = [];
  let i = 0;
  while (i < sections.length) {
    const sec = sections[i];
    if (!sec.label.includes("阅读理解")) {
      grouped.push(sec);
      i++;
      continue;
    }
    // Collect the run of consecutive 阅读理解 sections.
    let j = i;
    while (j + 1 < sections.length && sections[j + 1].label.includes("阅读理解")) j++;
    // Within [i..j], merge subsequent sections that read the SAME
    // passage page. 五-A's MCQ Q30-32 and 五-A's OEQ Q33 both OCR'd
    // page 10 separately, so their passage STRINGS differ slightly
    // even though the underlying printed passage is identical. Merge
    // by passagePageIndices overlap (recorded in step 2) — any single
    // shared page means the printed passage is the same.
    const overlaps = (a?: Set<number>, b?: Set<number>) => {
      if (!a || !b || a.size === 0 || b.size === 0) return false;
      for (const p of a) if (b.has(p)) return true;
      return false;
    };
    type Sub = BuiltSection & { _passagePages?: Set<number> };
    const subgroups: Sub[] = [{ ...sections[i], _passagePages: secPassagePages.get(sections[i]) }];
    for (let k = i + 1; k <= j; k++) {
      const s = sections[k];
      const cur = subgroups[subgroups.length - 1];
      const sPages = secPassagePages.get(s);
      const same = overlaps(cur._passagePages, sPages)
        // String-equality fallback for sections that don't have
        // passagePageIndices recorded (older extractions).
        || (!!s.passage && !!cur.passage && s.passage === cur.passage);
      if (same) {
        cur.endIndex = s.endIndex;
        // Keep the union so a later subgroup with overlapping pages
        // still merges. If the cur subgroup hasn't recorded pages,
        // adopt the new section's.
        if (sPages) {
          if (cur._passagePages) for (const p of sPages) cur._passagePages.add(p);
          else cur._passagePages = new Set(sPages);
        }
      } else {
        subgroups.push({ ...s, _passagePages: sPages });
      }
    }
    // Rename when this 阅读理解 run holds more than one passage —
    // those are the A组 / B组 of 阅读理解二. The A group typically
    // mixes MCQ + 1 long OEQ on the same passage; B is all OEQ. Tag
    // the labels accordingly so the /edit + quiz UIs can show them
    // distinctly without re-deriving the shape from question data.
    if (subgroups.length > 1) {
      subgroups.forEach((g, idx) => {
        const letter = String.fromCharCode(65 + idx);
        const startQ = questions[g.startIndex];
        const endQ = questions[g.endIndex];
        const allOeq = startQ && endQ &&
          // Detect "all OEQ" by checking syllabusTopic of bounds; mixed
          // groups (5-A) have an MCQ start, so this lands false there.
          (startQ.syllabusTopic ?? "").includes("OEQ") &&
          (endQ.syllabusTopic ?? "").includes("OEQ");
        g.label = allOeq ? `阅读理解 ${letter} OEQ` : `阅读理解 ${letter}`;
      });
    }
    // Strip the internal _passagePages field before persisting — it
    // exists only to drive the merge above.
    for (const g of subgroups) {
      const { _passagePages: _ignored, ...clean } = g as Sub & Record<string, unknown>;
      void _ignored;
      grouped.push(clean as BuiltSection);
    }
    i = j + 1;
  }
  return grouped;
}
