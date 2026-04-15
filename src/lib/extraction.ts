import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { prisma } from "@/lib/db";

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

async function cropQuestionServer(
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
 */
function splitAnswerBySubParts(fullAnswer: string, subParts: string): string {
  if (!fullAnswer || !subParts) return "";
  const letters = subParts.split("");
  // Build a regex that matches parts like "(a)", "(b)", etc.
  // Split the answer into labeled chunks
  const partRegex = /\(([a-z])\)\s*/gi;
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

    // 4. For English text-based extraction: skip image cropping entirely
    const detectedSubjectEarly = (result.header?.subject || paper.subject || "").toLowerCase();
    const isEnglishEarly = detectedSubjectEarly.includes("english");
    const hasTextExtraction = isEnglishEarly && result.pages.some(p =>
      p.questions.some(q => (q as { _stem?: string })._stem || (q as { _options?: string[] })._options)
    );

    // Pre-compute visual text pages for both text-based and image-based paths
    const visualTextPages: Buffer[] = [];
    if (isEnglishEarly) {
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
      console.log(`[extraction] English text-based: building questions from OCR text (no image crops)`);
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
          if (qTopic.includes("visual") && qTopic.includes("text") && visualTextPages.length > 0) {
            try {
              const stitched = await stitchPagesVertically(visualTextPages);
              qImageData = `data:image/jpeg;base64,${stitched.toString("base64")}`;
            } catch { /* ignore */ }
          }

          questions.push({
            questionNum: qNum,
            imageData: qImageData,
            answer,
            answerImageData: "",
            pageIndex: page.pageIndex,
            orderIndex: questions.length,
            yStartPct: q.yStartPct ?? null,
            yEndPct: q.yEndPct ?? null,
            marksAvailable: q.marksAvailable ?? result.marksPerQuestion?.[qNum] ?? null,
            syllabusTopic: q.syllabusTopic ?? result.syllabusTopics?.[qNum] ?? null,
            transcribedStem: ext._stem || ext._blankContext || ext._errorWord || undefined,
            transcribedOptions: ext._options || undefined,
          });
        }
      }

      // Sort questions by question number to maintain paper order
      questions.sort((a, b) => {
        const aNum = parseInt(a.questionNum.replace(/^[A-Z]\d*-/, ""), 10);
        const bNum = parseInt(b.questionNum.replace(/^[A-Z]\d*-/, ""), 10);
        return (aNum || 0) - (bNum || 0);
      });

      // Save
      const debugMetadata = result._debug ? (() => { const { rawResponses: _ignored, ...rest } = result._debug!; return rest; })() : null;
      const sectionOcrTexts = result.sectionOcrTexts ?? null;
      const vocabClozePassageImage: string | null = null; // TODO: extract if needed

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
            },
            extractionStatus: "ready",
          },
        }),
      ]);

      console.log(`[extraction] English text-based: ${questions.length} questions saved.`);
      // Fire-and-forget AI audit of the freshly extracted Q&A
      import("@/lib/audit-qa").then(m => m.auditPaper(paperId).catch(e => console.error(`[extraction] auditPaper failed:`, e)));
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

    const detectedSubject = (result.header?.subject || paper.subject || "").toLowerCase();
    const isEnglish = detectedSubject.includes("english");

    // English MCQ topics — use tighter top padding so answer options aren't clipped
    const ENGLISH_MCQ_TOPICS = new Set(["Grammar MCQ", "Vocabulary MCQ", "Vocabulary Cloze MCQ", "Visual Text Comprehension MCQ"]);

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

      const syllabusTopic = result.syllabusTopics?.[qNum] ?? null;
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
            syllabusTopic: result.syllabusTopics?.[qNum] ?? null,
          });
        }
        continue;
      }

      // Check for text content from English extraction (no image crop needed)
      const seg0 = segments[0] as { _stem?: string; _options?: string[]; _blankContext?: string; _errorWord?: string };
      const hasTextContent = isEnglish && (seg0._stem || seg0._options || seg0._blankContext || seg0._errorWord);

      let croppedImage = "";
      if (hasTextContent) {
        // English text-based: no image crop needed (except Visual Text which keeps page images)
        if (syllabusTopic === "Visual Text Comprehension MCQ" && visualTextPages.length > 0) {
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
        marksAvailable:
          result.marksPerQuestion?.[qNum] ?? null,
        syllabusTopic: result.syllabusTopics?.[qNum] ?? null,
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
