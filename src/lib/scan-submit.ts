import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { markExamPaper, markQuizPaper, markFocusedTest } from "@/lib/marking";
import { maskBottomRightCorner } from "@/lib/watermark";
import { isAdmin } from "@/lib/admin";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

export type SubmitScannedPaperArgs = {
  parentId: string;
  // The id may be either a master paper (email flow — print code
  // resolves to the master) or an existing assigned clone (in-app
  // flow — the parent dashboard already created a clone at
  // assignment time). The helper dispatches: clone → update in
  // place; master → create a new clone.
  paperId: string;
  studentId: string;
  jpegBuffers: Buffer[];
};

export type SubmitScannedPaperResult = {
  cloneId: string;
  pageCount: number;
};

// Shared core that both inbound-email/route.ts (parent emails scans) and the
// in-app scanner POST endpoint call. Saves the page JPEGs after watermark
// masking and kicks off marking. Throws on auth / validation failure so
// callers can map to their own response shape.
export async function submitScannedPaper(args: SubmitScannedPaperArgs): Promise<SubmitScannedPaperResult> {
  const { parentId, paperId, studentId, jpegBuffers } = args;
  if (jpegBuffers.length === 0) throw new Error("no pages");

  // Auth: parent must own the master paper or be linked to the student.
  // Admins bypass the link requirement (matches inbound-email behaviour).
  const parent = await prisma.user.findUnique({
    where: { id: parentId },
    select: { id: true, name: true, settings: true, role: true },
  });
  if (!parent) throw new Error("parent not found");

  if (!isAdmin(parent)) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId, studentId } },
      select: { studentId: true },
    });
    if (!link) throw new Error("parent not linked to student");
  }

  // Step 1 — figure out what was passed: an existing clone (in-app
  // assignment flow) or a master paper (email flow). We dispatch:
  //   - clone  → update completedAt + markingStatus, reuse the row
  //              the parent already sees on their dashboard
  //   - master → create a new clone (email-flow original behaviour,
  //              since the email has no clone to attach to)
  const target = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      sourceExamId: true,
      assignedToId: true,
      paperType: true,
      subject: true,
    },
  });
  if (!target) throw new Error("paper not found");

  let cloneId: string;

  if (target.assignedToId) {
    // The paper is already assigned to a student — reuse it as the
    // submission row instead of cloning. Covers three cases:
    //   - Clone of a regular master (sourceExamId set, paperType=null)
    //   - Quiz paper (paperType="quiz", no sourceExamId)
    //   - Focused-test paper (paperType="focused", no sourceExamId)
    // For all three the "paper" the parent sees on their dashboard
    // IS the student's working copy; we just attach photos and mark.
    if (target.assignedToId !== studentId) {
      throw new Error("paper assigned to a different student");
    }
    await prisma.examPaper.update({
      where: { id: target.id },
      data: {
        completedAt: new Date(),
        markingStatus: "in_progress",
        // Always instant-feedback for in-app scans — same rationale
        // as the email flow: parent watched the student write it.
        instantFeedback: true,
      },
    });
    cloneId = target.id;
  } else {
    // Email flow (or any caller that hands us a master): clone.
    const masterPaper = await prisma.examPaper.findUnique({
      where: { id: target.id },
      select: {
        id: true,
        title: true,
        subject: true,
        level: true,
        examType: true,
        paperType: true,
        totalMarks: true,
        metadata: true,
        pageCount: true,
        userId: true,
        questions: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!masterPaper) throw new Error("master paper not found");

    const clone = await prisma.examPaper.create({
      data: {
        title: masterPaper.title,
        subject: masterPaper.subject,
        level: masterPaper.level,
        examType: masterPaper.examType,
        totalMarks: masterPaper.totalMarks,
        metadata: masterPaper.metadata ?? Prisma.JsonNull,
        pageCount: masterPaper.pageCount,
        instantFeedback: true,
        userId: masterPaper.userId,
        assignedToId: studentId,
        sourceExamId: masterPaper.id,
        paperType: masterPaper.paperType,
        completedAt: new Date(),
        markingStatus: "in_progress",
        questions: {
          create: masterPaper.questions.map((q) => ({
            questionNum: q.questionNum,
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            pageIndex: q.pageIndex,
            orderIndex: q.orderIndex,
            yStartPct: q.yStartPct,
            yEndPct: q.yEndPct,
            marksAvailable: q.marksAvailable,
            syllabusTopic: q.syllabusTopic,
            transcribedStem: q.transcribedStem,
            transcribedOptions: (q.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            transcribedOptionImages: (q.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            transcribedSubparts: (q.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            diagramImageData: q.diagramImageData,
            diagramBounds: (q.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            sourceQuestionId: q.id,
          })),
        },
      },
      select: { id: true },
    });
    cloneId = clone.id;
  }

  // Re-encode every page through sharp to a uniform 1800px JPEG so the
  // marker sees comparable input regardless of source (raw camera vs
  // pre-processed scanner). 1800px ≈ 220 DPI for an A4 page — good
  // enough for handwritten Comp Cloze blanks (each ~80px tall row,
  // ~30-45px per letter) without ballooning file size. Up from 1600
  // (was leaving too little headroom on tight handwriting) but
  // deliberately not all the way to 2400 — diminishing accuracy
  // return past 1800 and ~5 MB per 20-page paper is the right cost
  // ceiling. withoutEnlargement keeps phones that already shoot at
  // lower resolution from being upscaled (no synthetic detail).
  // Then mask the watermark corner.
  const subDir = path.join(SUBMISSIONS_DIR, cloneId);
  await fs.mkdir(subDir, { recursive: true });
  let saved = 0;
  for (let i = 0; i < jpegBuffers.length; i++) {
    try {
      const norm = await sharp(jpegBuffers[i])
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
      const masked = await maskBottomRightCorner(norm);
      await fs.writeFile(path.join(subDir, `page_${saved}.jpg`), masked);
      saved++;
    } catch (err) {
      console.error(`[scan-submit] failed to save page ${i} for ${cloneId}:`, err);
    }
  }
  if (saved === 0) {
    // No usable pages. If we'd just CREATED a clone (email path),
    // delete it so we don't leak orphan rows. If we updated an
    // existing clone (in-app path) leave it — it was assigned and
    // the parent can re-scan.
    if (!target.sourceExamId) {
      prisma.examPaper.delete({ where: { id: cloneId } }).catch(() => {});
    }
    throw new Error("no usable pages");
  }
  console.log(`[scan-submit] saved ${saved} page JPGs for clone=${cloneId} student=${studentId} mode=${target.sourceExamId ? "update" : "create"}`);

  // Build oeqPageMap from each question's printableBounds so the
  // review page knows which scan file to show for each question.
  // Without this map the review page falls back to the OEQ array
  // index, which only works for in-app canvas papers (where every
  // question owns its own page_<i>.jpg). Scanned-back printables
  // have many questions per scan page → the wrong image shows.
  //
  // Map shape: { [questionId]: scanFileIndex }, matching the
  // existing in-app metadata.oeqPageMap shape that the review page
  // already reads. scanFileIndex = printableBounds.pageIndex + 1
  // (cover offset).
  try {
    const cloneQuestions = await prisma.examQuestion.findMany({
      where: { examPaperId: cloneId },
      select: { id: true, printableBounds: true },
    });
    const { pickScanFileIndex } = await import("@/lib/page-map");
    const pageMap: Record<string, number> = {};
    for (const q of cloneQuestions) {
      const scanIdx = pickScanFileIndex(q.printableBounds as Parameters<typeof pickScanFileIndex>[0]);
      if (scanIdx !== null) pageMap[q.id] = scanIdx;
    }
    if (Object.keys(pageMap).length > 0) {
      const existing = await prisma.examPaper.findUnique({
        where: { id: cloneId },
        select: { metadata: true },
      });
      const meta = (existing?.metadata ?? {}) as Record<string, unknown>;
      await prisma.examPaper.update({
        where: { id: cloneId },
        data: {
          metadata: { ...meta, oeqPageMap: pageMap } as Prisma.InputJsonValue,
        },
      });
      console.log(`[scan-submit] wrote oeqPageMap for ${Object.keys(pageMap).length} questions on clone=${cloneId}`);
    }
  } catch (err) {
    console.warn(`[scan-submit] failed to build oeqPageMap for ${cloneId}:`, err);
  }

  // Dispatch marker by paperType: quiz/focused use markQuizPaper /
  // markFocusedTest (different prompts, per-subpart canvas reading,
  // etc.); regular paper clones use markExamPaper.
  //
  // English Test Quiz override: the user prints English Test Quizzes
  // from the original master PDF and writes on the paper directly
  // (we route /print -> source pdfPath for the English Test Quiz
  // case). markExamPaper is the bounds-based reader that handles
  // that layout — same code path math/science regular masters use —
  // so dispatch through it instead of markQuizPaper for English.
  const subjLc = (target.subject ?? "").toLowerCase();
  const subjRaw = target.subject ?? "";
  const isEnglishTestQuiz = target.paperType === "quiz" && subjLc.includes("english");
  // Chinese Test Quiz mirrors the English override: the print flow
  // uses the original PDF + appended oeq_pad.pdf, and the scan-back
  // marker reads per-question pageIndex/yStart/yEnd from the DB
  // (the OEQ pad generator wrote those when the pad was created).
  // Route through markExamPaper so the bounds-based pipeline runs.
  const isChineseTestQuiz = target.paperType === "quiz" && (
    subjLc.includes("chinese") || subjRaw.includes("华文") || subjRaw.includes("中文") || subjRaw.includes("华语")
  );
  const markFn = (isEnglishTestQuiz || isChineseTestQuiz)
    ? markExamPaper
    : target.paperType === "quiz"
      ? markQuizPaper
      : target.paperType === "focused"
        ? markFocusedTest
        : markExamPaper;
  markFn(cloneId).catch((err) => {
    console.error(`[scan-submit] mark (${target.paperType ?? "regular"}) failed for ${cloneId}:`, err);
  });

  return { cloneId, pageCount: saved };
}
