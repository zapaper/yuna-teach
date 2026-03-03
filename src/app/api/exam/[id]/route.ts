import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { promises as fs } from "fs";
import path from "path";

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
          ? { id: true, questionNum: true, answer: true, orderIndex: true, pageIndex: true, yStartPct: true, yEndPct: true, marksAwarded: true, marksAvailable: true, markingNotes: true }
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

  const paper = await prisma.examPaper.update({ where: { id }, data });

  return NextResponse.json({ success: true, id: paper.id });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  await prisma.examPaper.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
