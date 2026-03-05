import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import {
  analyzeExamBatch,
  normalizeAnswer,
  type AnswerEntry,
  type BatchAnalysisResult,
} from "@/lib/gemini";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

async function cropQuestionServer(
  imageBuffer: Buffer,
  yStartPct: number,
  yEndPct: number
): Promise<string> {
  const metadata = await sharp(imageBuffer).metadata();
  const height = metadata.height!;
  const width = metadata.width!;
  const topPad = Math.round(0.05 * height);
  const botPad = Math.round(0.02 * height);
  const top = Math.max(
    0,
    Math.floor((yStartPct / 100) * height) - topPad
  );
  const bottom = Math.min(
    height,
    Math.ceil((yEndPct / 100) * height) + botPad
  );
  const cropHeight = bottom - top;
  if (cropHeight <= 0) {
    // Fallback: return full image
    const buf = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  }
  const croppedBuffer = await sharp(imageBuffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`;
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
  pageCount: number
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

  // If previous question ended at bottom of page (>=90%), move to next page
  if (prevQuestion && prevQuestion.yEndPct >= 90) {
    const nextPage = prevQuestion.pageIndex + 1;
    if (extractedPageIndex <= prevQuestion.pageIndex && nextPage < pageCount) {
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

export async function extractExamPaperBackground(
  paperId: string
): Promise<void> {
  console.log(`[extraction] Starting background extraction for ${paperId}`);

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

    // 4. Collect all question segments (including multi-page continuations)
    type QuestionSegment = {
      questionNum: string;
      pageIndex: number;
      yStartPct: number;
      yEndPct: number;
      isContinuation: boolean;
      subParts: string;
    };

    const allSegments: QuestionSegment[] = [];
    let lastCroppedQuestion: {
      pageIndex: number;
      yEndPct: number;
    } | null = null;

    for (const page of result.pages) {
      if (page.isAnswerSheet) continue;

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
              paper.pageCount
            );

        allSegments.push({
          questionNum: q.questionNum,
          pageIndex: correctPageIndex,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          isContinuation: isCont,
          subParts,
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

    // Determine if this is a science paper — split multi-page questions per page
    const detectedSubject = (result.header?.subject || paper.subject || "").toLowerCase();
    const isScience = detectedSubject.includes("science");

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
    }> = [];

    for (const qNum of questionOrder) {
      const segments = questionGroups.get(qNum)!;

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
            seg.yEndPct
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
          });
        }
        continue;
      }

      // Single page
      const croppedImage = await cropQuestionServer(
        imageBuffers[segments[0].pageIndex],
        segments[0].yStartPct,
        segments[0].yEndPct
      );

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
      });
    }

    // 5. Build metadata to save
    const debugMetadata = result._debug
      ? (() => {
          const { rawResponses: _ignored, ...rest } = result._debug;
          return rest;
        })()
      : null;

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
            examPaperId: paperId,
          },
        })
      ),
      // Update paper with extracted info
      prisma.examPaper.update({
        where: { id: paperId },
        data: {
          title: result.header?.title || paper.title,
          school: result.header?.school || paper.school,
          level: result.header?.level || paper.level,
          subject: result.header?.subject || paper.subject,
          year: result.header?.year || paper.year,
          semester: result.header?.semester || paper.semester,
          totalMarks: result.header?.totalMarks || paper.totalMarks,
          metadata: debugMetadata as object ?? undefined,
          extractionStatus: "ready",
        },
      }),
    ]);

    console.log(
      `[extraction] Paper ${paperId} done. ${questions.length} questions extracted.`
    );
  } catch (err) {
    console.error(`[extraction] Failed for ${paperId}:`, err);
    await prisma.examPaper
      .update({
        where: { id: paperId },
        data: { extractionStatus: "failed" },
      })
      .catch(() => {});
  }
}
