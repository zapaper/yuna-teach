import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { isSessionAdmin } from "@/lib/session";

// POST /api/admin/setup-review-demo
//
// Idempotent server-side setup for the App Store review demo:
//   parent  — review@markforyou.com  / 1234
//   student — review-student          / 1234  (linked to parent)
//
// Clones Emily's most recent 10 completed quizzes/focused-tests AND
// copies the corresponding submission directory off Railway's volume
// so the canvas (handwritten + drawn answers) renders for the
// reviewer, not just the marking metadata.
//
// Was originally a local Prisma script, but the on-disk submission
// files live under VOLUME_PATH on Railway and aren't reachable from
// my Windows box. Moving the flow server-side fixes that.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

const PARENT_EMAIL = "review@markforyou.com";
const PARENT_PASSWORD = "1234";
const STUDENT_USERNAME = "review-student";
const STUDENT_PASSWORD = "1234";
const CLONE_COUNT = 10;
const SOURCE_STUDENT_NAME_NEEDLE = "emily";

async function copyDirIfExists(src: string, dst: string): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  try {
    const stat = await fs.stat(src).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return { ok: false, reason: "source not a directory" };
    }
    await fs.mkdir(dst, { recursive: true });
    let bytes = 0;
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isFile()) {
        const buf = await fs.readFile(s);
        await fs.writeFile(d, buf);
        bytes += buf.length;
      }
    }
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const log: string[] = [];

  // 1. Source student — Emily Lim.
  const emily = await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      OR: [
        { name: { contains: SOURCE_STUDENT_NAME_NEEDLE, mode: "insensitive" } },
        { displayName: { contains: SOURCE_STUDENT_NAME_NEEDLE, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, level: true },
  });
  if (!emily) {
    return NextResponse.json({ error: "Emily not found" }, { status: 404 });
  }
  log.push(`source: ${emily.name} (${emily.id}) P${emily.level}`);

  // 2. Upsert parent.
  let parent = await prisma.user.findUnique({ where: { email: PARENT_EMAIL } });
  if (!parent) {
    parent = await prisma.user.create({
      data: {
        name: "Review Parent",
        displayName: "App Review",
        email: PARENT_EMAIL,
        password: PARENT_PASSWORD,
        role: "PARENT",
        emailVerified: true,
      },
    });
    log.push(`created parent ${parent.id}`);
  } else {
    parent = await prisma.user.update({
      where: { id: parent.id },
      data: { password: PARENT_PASSWORD, emailVerified: true, role: "PARENT" },
    });
    log.push(`reused parent ${parent.id}`);
  }

  // 3. Upsert student.
  let student = await prisma.user.findFirst({
    where: { name: STUDENT_USERNAME, role: "STUDENT" },
  });
  if (!student) {
    student = await prisma.user.create({
      data: {
        name: STUDENT_USERNAME,
        displayName: "Demo Student",
        password: STUDENT_PASSWORD,
        role: "STUDENT",
        level: emily.level ?? 6,
        settings: { avatar: true, habitats: true, studentQuizMode: "none" } as Prisma.InputJsonValue,
      },
    });
    log.push(`created student ${student.id}`);
  } else {
    student = await prisma.user.update({
      where: { id: student.id },
      data: { password: STUDENT_PASSWORD, level: emily.level ?? 6, role: "STUDENT" },
    });
    log.push(`reused student ${student.id}`);
  }

  // 4. Link.
  await prisma.parentStudent.upsert({
    where: { parentId_studentId: { parentId: parent.id, studentId: student.id } },
    create: { parentId: parent.id, studentId: student.id },
    update: {},
  });

  // 5. Pull Emily's last 10 completed quizzes/focused tests.
  const sourcePapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: emily.id,
      completedAt: { not: null },
      markingStatus: { in: ["complete", "released"] },
      paperType: { in: ["quiz", "focused"] },
    },
    orderBy: { completedAt: "desc" },
    take: CLONE_COUNT,
    include: { questions: true },
  });
  log.push(`pulled ${sourcePapers.length} source papers`);

  // 6. Wipe previous demo clones (DB + on-disk submissions).
  const existingClones = await prisma.examPaper.findMany({
    where: { assignedToId: student.id, userId: parent.id },
    select: { id: true },
  });
  for (const c of existingClones) {
    await fs.rm(path.join(SUBMISSIONS_DIR, c.id), { recursive: true, force: true });
  }
  if (existingClones.length > 0) {
    await prisma.examPaper.deleteMany({ where: { id: { in: existingClones.map(c => c.id) } } });
    log.push(`wiped ${existingClones.length} previous demo clones (DB + files)`);
  }

  // 7. Clone each paper and copy its submission directory.
  let totalBytes = 0;
  let copiedDirs = 0;
  let missingDirs = 0;
  for (const src of sourcePapers) {
    const newPaper = await prisma.examPaper.create({
      data: {
        title: src.title,
        school: src.school,
        level: src.level,
        subject: src.subject,
        year: src.year,
        semester: src.semester,
        totalMarks: src.totalMarks,
        metadata: src.metadata ?? Prisma.JsonNull,
        pdfPath: src.pdfPath,
        pageCount: src.pageCount,
        scheduledFor: src.scheduledFor,
        userId: parent.id,
        assignedToId: student.id,
        score: src.score,
        completedAt: src.completedAt,
        timeSpentSeconds: src.timeSpentSeconds,
        instantFeedback: src.instantFeedback,
        markingStatus: src.markingStatus,
        extractionStatus: src.extractionStatus,
        feedbackSummary: src.feedbackSummary,
        sourceExamId: src.sourceExamId ?? src.id,
        paperType: src.paperType,
        examType: src.examType,
        visible: src.visible,
        annotationsByPage: src.annotationsByPage ?? Prisma.JsonNull,
        reviewAnnotations: src.reviewAnnotations ?? Prisma.JsonNull,
        questions: {
          create: src.questions.map((q) => ({
            questionNum: q.questionNum,
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            pageIndex: q.pageIndex,
            orderIndex: q.orderIndex,
            yStartPct: q.yStartPct,
            yEndPct: q.yEndPct,
            marksAwarded: q.marksAwarded,
            marksAvailable: q.marksAvailable,
            markingNotes: q.markingNotes,
            syllabusTopic: q.syllabusTopic,
            studentAnswer: q.studentAnswer,
            elaboration: q.elaboration,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? Prisma.JsonNull,
            transcribedOptionImages: q.transcribedOptionImages ?? Prisma.JsonNull,
            transcribedSubparts: q.transcribedSubparts ?? Prisma.JsonNull,
            diagramBounds: q.diagramBounds ?? Prisma.JsonNull,
            diagramImageData: q.diagramImageData,
            sourceQuestionId: q.sourceQuestionId ?? q.id,
            difficulty: q.difficulty,
          })),
        },
      },
    });
    const result = await copyDirIfExists(
      path.join(SUBMISSIONS_DIR, src.id),
      path.join(SUBMISSIONS_DIR, newPaper.id),
    );
    if (result.ok) {
      copiedDirs++;
      totalBytes += result.bytes;
    } else {
      missingDirs++;
      log.push(`  no submissions for ${src.title} (${src.id}): ${result.reason}`);
    }
  }
  log.push(`cloned ${sourcePapers.length} papers; copied ${copiedDirs} submission dirs (${(totalBytes / 1024).toFixed(0)} KB), ${missingDirs} had no on-disk files`);

  return NextResponse.json({
    ok: true,
    parent: { id: parent.id, email: PARENT_EMAIL, password: PARENT_PASSWORD },
    student: { id: student.id, name: STUDENT_USERNAME, password: STUDENT_PASSWORD },
    log,
  });
}
