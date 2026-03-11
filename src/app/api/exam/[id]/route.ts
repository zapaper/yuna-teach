import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { promises as fs } from "fs";
import path from "path";
import { extractExamPaperBackground } from "@/lib/extraction";
import { tagSyllabusTopics } from "@/lib/gemini";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const summary = request.nextUrl.searchParams.get("summary") === "true";

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    include: {
      questions: {
        orderBy: { orderIndex: "asc" },
        select: summary
          ? { id: true, questionNum: true, answer: true, orderIndex: true, pageIndex: true, yStartPct: true, yEndPct: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true }
          : undefined,
      },
      assignedTo: { select: { id: true, name: true } },
      clones: {
        select: {
          id: true,
          assignedToId: true,
          completedAt: true,
          score: true,
          markingStatus: true,
          feedbackSummary: true,
          timeSpentSeconds: true,
          instantFeedback: true,
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...paper,
    assignedToName: paper.assignedTo?.name ?? null,
    clones: paper.clones.map((c) => ({
      id: c.id,
      assignedToId: c.assignedToId,
      assignedToName: c.assignedTo?.name ?? null,
      completedAt: c.completedAt?.toISOString() ?? null,
      score: c.score,
      markingStatus: c.markingStatus,
      feedbackSummary: c.feedbackSummary,
      timeSpentSeconds: c.timeSpentSeconds,
    })),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // --- Clone-on-assign: when assignedToId is provided, create a clone ---
  if ("assignedToId" in body && body.assignedToId) {
    const studentId = body.assignedToId as string;
    const instantFeedback = body.instantFeedback === true;

    // Check if clone already exists for this student + master
    const existing = await prisma.examPaper.findFirst({
      where: { sourceExamId: id, assignedToId: studentId },
    });
    if (existing) {
      return NextResponse.json({ success: true, id: existing.id, alreadyAssigned: true });
    }

    // Fetch master paper + questions
    const master = await prisma.examPaper.findUnique({
      where: { id },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!master) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Create clone with questions
    const clone = await prisma.examPaper.create({
      data: {
        title: master.title,
        school: master.school,
        level: master.level,
        subject: master.subject,
        year: master.year,
        semester: master.semester,
        totalMarks: master.totalMarks,
        metadata: master.metadata ?? undefined,
        pdfPath: master.pdfPath,
        pageCount: master.pageCount,
        userId: master.userId,
        assignedToId: studentId,
        sourceExamId: id,
        paperType: master.paperType,
        examType: master.examType,
        instantFeedback,
        questions: {
          create: master.questions.map((q) => ({
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
          })),
        },
      },
    });

    // Auto-migrate legacy assignment (pre-clone data on master) to a proper clone
    if (master.assignedToId && master.assignedToId !== studentId) {
      const legacyCloneExists = await prisma.examPaper.findFirst({
        where: { sourceExamId: id, assignedToId: master.assignedToId },
      });
      if (!legacyCloneExists) {
        const legacyClone = await prisma.examPaper.create({
          data: {
            title: master.title,
            school: master.school,
            level: master.level,
            subject: master.subject,
            year: master.year,
            semester: master.semester,
            totalMarks: master.totalMarks,
            metadata: master.metadata ?? undefined,
            pdfPath: master.pdfPath,
            pageCount: master.pageCount,
            userId: master.userId,
            assignedToId: master.assignedToId,
            sourceExamId: id,
            examType: master.examType,
            completedAt: master.completedAt,
            score: master.score,
            markingStatus: master.markingStatus,
            feedbackSummary: master.feedbackSummary,
            timeSpentSeconds: master.timeSpentSeconds,
            questions: {
              create: master.questions.map((q) => ({
                questionNum: q.questionNum,
                imageData: q.imageData,
                answer: q.answer,
                answerImageData: q.answerImageData,
                pageIndex: q.pageIndex,
                orderIndex: q.orderIndex,
                yStartPct: q.yStartPct,
                yEndPct: q.yEndPct,
                marksAvailable: q.marksAvailable,
                marksAwarded: q.marksAwarded,
                markingNotes: q.markingNotes,
              })),
            },
          },
        });

        // Copy submission files from master folder to legacy clone folder
        const masterDir = path.join(SUBMISSIONS_DIR, id);
        const cloneDir = path.join(SUBMISSIONS_DIR, legacyClone.id);
        try {
          const files = await fs.readdir(masterDir);
          await fs.mkdir(cloneDir, { recursive: true });
          for (const file of files) {
            await fs.copyFile(
              path.join(masterDir, file),
              path.join(cloneDir, file)
            );
          }
        } catch {
          // No submission files to copy yet
        }
      }

      // Clear legacy data from master
      await prisma.examPaper.update({
        where: { id },
        data: {
          assignedToId: null,
          completedAt: null,
          score: null,
          markingStatus: null,
          feedbackSummary: null,
          timeSpentSeconds: 0,
        },
      });
    }

    return NextResponse.json({ success: true, id: clone.id });
  }

  // --- Retry extraction ---
  if (body.retryExtraction) {
    await prisma.examPaper.update({
      where: { id },
      data: { extractionStatus: "processing" },
    });
    extractExamPaperBackground(id).catch((err) =>
      console.error(`[retry-extraction] Failed for ${id}:`, err)
    );
    return NextResponse.json({ success: true, restarted: true });
  }

  // --- Regular field updates (non-assignment) ---
  const data: Record<string, unknown> = {};
  if ("assignedToId" in body && !body.assignedToId) data.assignedToId = null;
  if ("score" in body) data.score = body.score ?? null;
  if ("completedAt" in body)
    data.completedAt = body.completedAt ? new Date(body.completedAt) : null;
  if ("totalMarks" in body) data.totalMarks = body.totalMarks || null;
  if ("timeSpentSeconds" in body && typeof body.timeSpentSeconds === "number")
    data.timeSpentSeconds = body.timeSpentSeconds;
  if ("feedbackSummary" in body) data.feedbackSummary = body.feedbackSummary ?? null;
  if ("markingStatus" in body) data.markingStatus = body.markingStatus ?? null;
  if ("examType" in body) data.examType = body.examType || null;
  if ("title" in body && typeof body.title === "string") data.title = body.title;
  if ("extractionStatus" in body) data.extractionStatus = body.extractionStatus || null;

  const paper = await prisma.examPaper.update({ where: { id }, data });

  return NextResponse.json({ success: true, id: paper.id });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Add a blank question to this exam paper
  if (body.action === "addQuestion") {
    const afterOrder = typeof body.afterOrderIndex === "number" ? body.afterOrderIndex : null;

    if (afterOrder !== null) {
      // Shift all questions after the insertion point
      await prisma.examQuestion.updateMany({
        where: { examPaperId: id, orderIndex: { gt: afterOrder } },
        data: { orderIndex: { increment: 1 } },
      });
    }

    // Get the current max orderIndex (after shift)
    const lastQuestion = await prisma.examQuestion.findFirst({
      where: { examPaperId: id },
      orderBy: { orderIndex: "desc" },
    });
    const insertOrder = afterOrder !== null ? afterOrder + 1 : (lastQuestion?.orderIndex ?? -1) + 1;
    const refQuestion = afterOrder !== null
      ? await prisma.examQuestion.findFirst({ where: { examPaperId: id, orderIndex: afterOrder } })
      : lastQuestion;
    const nextNum = body.questionNum || String(insertOrder + 1);

    const question = await prisma.examQuestion.create({
      data: {
        questionNum: nextNum,
        imageData: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=", // 1x1 white pixel
        answer: null,
        answerImageData: null,
        pageIndex: refQuestion?.pageIndex ?? 0,
        orderIndex: insertOrder,
        yStartPct: null,
        yEndPct: null,
        marksAvailable: null,
        examPaperId: id,
      },
    });

    return NextResponse.json(question);
  }

  // --- Tag syllabus topics (Math & Science) ---
  if (body.action === "tagSyllabus") {
    const paper = await prisma.examPaper.findUnique({
      where: { id },
      select: { subject: true },
    });

    const questions = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      orderBy: { orderIndex: "asc" },
      select: { id: true, questionNum: true, imageData: true },
    });

    // Strip data URL prefix to get raw base64
    const questionsForAI = questions.map((q) => ({
      questionNum: q.questionNum,
      imageBase64: q.imageData.replace(/^data:image\/\w+;base64,/, ""),
    }));

    const tags = await tagSyllabusTopics(questionsForAI, paper?.subject ?? undefined);

    // Update each question with its tag
    const updates = questions
      .filter((q) => q.questionNum in tags)
      .map((q) =>
        prisma.examQuestion.update({
          where: { id: q.id },
          data: { syllabusTopic: tags[q.questionNum] ?? null },
        })
      );
    await prisma.$transaction(updates);

    // Return the tags for client-side update
    return NextResponse.json({ success: true, tags });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const requesterId = searchParams.get("userId");

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { paperType: true, assignedToId: true, completedAt: true, userId: true },
  });

  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Non-admin users may only delete focused tests they own
  const isAdmin = requesterId === null; // admin calls don't pass userId, or check by name below
  const requester = requesterId
    ? await prisma.user.findUnique({ where: { id: requesterId }, select: { name: true } })
    : null;
  const callerIsAdmin = requester?.name?.toLowerCase() === "admin";

  if (!callerIsAdmin) {
    if (paper.paperType !== "focused") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (paper.userId !== requesterId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // For focused tests assigned to a student, soft-delete by clearing parent's userId
  // so it disappears from parent's list but stays for the student
  if (paper.paperType === "focused" && paper.assignedToId && paper.completedAt) {
    // Transfer ownership to the student so it stays on their homepage
    await prisma.examPaper.update({
      where: { id },
      data: { userId: paper.assignedToId },
    });
  } else {
    await prisma.examPaper.delete({ where: { id } });
  }

  return NextResponse.json({ success: true });
}
