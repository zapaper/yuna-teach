import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { markExamPaper } from "@/lib/marking";
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
    },
  });
  if (!target) throw new Error("paper not found");

  let cloneId: string;

  if (target.sourceExamId) {
    // In-app flow: the parent tapped Scan on an already-assigned card.
    // The clone is `target`. Sanity-check the assignment matches.
    if (target.assignedToId && target.assignedToId !== studentId) {
      throw new Error("paper assigned to a different student");
    }
    await prisma.examPaper.update({
      where: { id: target.id },
      data: {
        assignedToId: studentId,
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

  // Re-encode every page through sharp to a uniform 1600px JPEG so the
  // marker sees comparable input regardless of source (raw camera vs
  // pre-processed scanner). Then mask the watermark corner.
  const subDir = path.join(SUBMISSIONS_DIR, cloneId);
  await fs.mkdir(subDir, { recursive: true });
  let saved = 0;
  for (let i = 0; i < jpegBuffers.length; i++) {
    try {
      const norm = await sharp(jpegBuffers[i])
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 88 })
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

  markExamPaper(cloneId).catch((err) => {
    console.error(`[scan-submit] markExamPaper failed for ${cloneId}:`, err);
  });

  return { cloneId, pageCount: saved };
}
