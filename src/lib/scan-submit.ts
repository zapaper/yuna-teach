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
  masterPaperId: string;
  studentId: string;
  jpegBuffers: Buffer[];
};

export type SubmitScannedPaperResult = {
  cloneId: string;
  pageCount: number;
};

// Shared core that both inbound-email/route.ts (parent emails scans) and the
// in-app scanner POST endpoint call. Clones the master paper, saves the page
// JPEGs after watermark masking, and kicks off marking. Throws on auth /
// validation failure so callers can map to their own response shape.
export async function submitScannedPaper(args: SubmitScannedPaperArgs): Promise<SubmitScannedPaperResult> {
  const { parentId, masterPaperId, studentId, jpegBuffers } = args;
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

  const masterPaper = await prisma.examPaper.findFirst({
    where: { id: masterPaperId, sourceExamId: null },
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

  // Mirrors the clone shape created in inbound-email/route.ts:211–255.
  const clone = await prisma.examPaper.create({
    data: {
      title: masterPaper.title,
      subject: masterPaper.subject,
      level: masterPaper.level,
      examType: masterPaper.examType,
      totalMarks: masterPaper.totalMarks,
      metadata: masterPaper.metadata ?? Prisma.JsonNull,
      pageCount: masterPaper.pageCount,
      // Parent has watched the student write on the printed paper, so
      // students can see results as soon as marking finishes — no
      // separate review-and-release gate.
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

  // Re-encode every page through sharp to a uniform 1600px JPEG so the
  // marker sees comparable input regardless of source (raw camera vs
  // pre-processed scanner). Then mask the watermark corner.
  const subDir = path.join(SUBMISSIONS_DIR, clone.id);
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
      console.error(`[scan-submit] failed to save page ${i} for ${clone.id}:`, err);
    }
  }
  if (saved === 0) {
    // No usable pages — best-effort cleanup of the empty clone so we don't
    // leak orphan rows. Fire-and-forget; if the cleanup fails the row stays.
    prisma.examPaper.delete({ where: { id: clone.id } }).catch(() => {});
    throw new Error("no usable pages");
  }
  console.log(`[scan-submit] saved ${saved} page JPGs for clone=${clone.id} master=${masterPaper.id} student=${studentId}`);

  markExamPaper(clone.id).catch((err) => {
    console.error(`[scan-submit] markExamPaper failed for ${clone.id}:`, err);
  });

  return { cloneId: clone.id, pageCount: saved };
}
