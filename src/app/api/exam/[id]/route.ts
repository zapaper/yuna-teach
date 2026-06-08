import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/admin";
import { promises as fs } from "fs";
import path from "path";
import { extractExamPaperBackground } from "@/lib/extraction";
import { tagSyllabusTopics } from "@/lib/gemini";
import { bumpUserActivity } from "@/lib/track-activity";
import { guardCanAssign } from "@/lib/subscription";
import { requireAccessToPaper, requireSession } from "@/lib/auth-guard";

// (hasStaleMcqMarks helper + the GET-handler "lazy auto-heal on review-
// page open" path were removed.) The same staleness check now runs
// ONCE at the tail of markExamPaper / markQuizPaper as a deterministic
// MCQ reconciliation pass (see `reconcileMcqMarks` in src/lib/marking.ts).
// That keeps the read path side-effect-free and prevents the heal from
// firing every time a parent opens the review page.

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const summary = request.nextUrl.searchParams.get("summary") === "true";

  // Caller comes from the session, not the URL — was previously
  // looking up the user by ?userId= and trusting whatever id the
  // caller pasted in. That meant a non-admin could send
  // ?userId=<adminId> and the response would set requesterIsAdmin:true,
  // unlocking admin UI affordances client-side. Session identity
  // closes that. Access check also moves here: caller must own the
  // paper, be the assigned student, a linked parent, or admin.
  const auth = await requireAccessToPaper(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    include: {
      questions: {
        orderBy: { orderIndex: "asc" },
        select: summary
          ? { id: true, questionNum: true, answer: true, orderIndex: true, pageIndex: true, yStartPct: true, yEndPct: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true }
          : undefined,
      },
      assignedTo: { select: { id: true, name: true, settings: true } },
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
          assignedTo: { select: { id: true, name: true, settings: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const requesterIsAdmin = auth.isAdmin;

  return NextResponse.json({
    ...paper,
    requesterIsAdmin,
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

  // --- Clone-on-assign: gated on the student being assigned to,
  // not on master-paper ownership. Master papers in the catalogue
  // are owned by the admin user; any parent should be able to clone
  // one onto their own linked student. A separate (stricter) check
  // runs further down for non-assign field updates.
  if ("assignedToId" in body && body.assignedToId) {
    const studentId = body.assignedToId as string;
    const session = await requireSession();
    if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status });
    let allowed = session.isAdmin || session.userId === studentId;
    if (!allowed) {
      const link = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: session.userId, studentId } },
        select: { id: true },
      });
      allowed = !!link;
    }
    if (!allowed) {
      return NextResponse.json({ error: "Not authorized to assign this paper to this student." }, { status: 403 });
    }
    // Track the parent's activity for the admin "Last active" stamp.
    const masterForBump = await prisma.examPaper.findUnique({ where: { id }, select: { userId: true, subject: true } });
    bumpUserActivity(masterForBump?.userId ?? null);
    // Chinese papers: admin-only assignment. Non-admins shouldn't be
    // able to clone a Chinese master onto any student even if a
    // stale UI somehow exposes the action — the API list endpoint
    // already hides Chinese papers from non-admins, this is the
    // belt-and-braces guard. Admin role is determined from the
    // session, not the URL.
    const isChineseSubject = (masterForBump?.subject ?? "").toLowerCase().includes("chinese");
    if (isChineseSubject && !session.isAdmin) {
      return NextResponse.json({ error: "Chinese papers can only be assigned by an admin." }, { status: 403 });
    }
    // Trial / subscription gate. The assigner is the master paper's
    // owner (parent); admin-owned masters bypass the gate via
    // guardCanAssign returning null for users without subscription
    // but with admin role — admins are allowed to assign across
    // accounts for support. (canAssign relies on isAdmin; nothing
    // extra to add here.)
    const blocked = await guardCanAssign(masterForBump?.userId);
    if (blocked) return blocked;
    const instantFeedback = body.instantFeedback === true;

    // Check if an incomplete clone already exists for this student + master
    const existingAny = await prisma.examPaper.findFirst({
      where: { sourceExamId: id, assignedToId: studentId },
      select: { id: true, completedAt: true },
    });
    const existing = existingAny?.completedAt == null ? existingAny : null;
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

    // Auto-create the parent_students link if the parent skipped the
    // signup linking step but has reached the assign flow. Without
    // this, the admin page (and other features that read parentLinks)
    // see "no linked students" even though the parent's clearly
    // working with that student. upsert is idempotent so existing
    // links are no-ops.
    //
    // Skip when the assigning user is admin: admin assigns papers
    // across many students for testing and shouldn't auto-grow link
    // rows for all of them. Mirrors scripts/backfill-parent-links.ts.
    if (master.userId && master.userId !== studentId) {
      const assigner = await prisma.user.findUnique({
        where: { id: master.userId },
        select: { name: true, settings: true },
      });
      if (!isAdmin(assigner)) {
        try {
          await prisma.parentStudent.upsert({
            where: { parentId_studentId: { parentId: master.userId, studentId } },
            update: {},
            create: { parentId: master.userId, studentId },
          });
        } catch (err) {
          console.warn(`[assign] couldn't auto-link parent=${master.userId} student=${studentId}:`, err);
        }
      }
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
            xStartPct: q.xStartPct,
            xEndPct: q.xEndPct,
            marksAvailable: q.marksAvailable,
            syllabusTopic: q.syllabusTopic,
            // Clean-extract fields: without these, /quiz can't render
            // typed-answer stems/options for English / Chinese clones
            // and they fall back to the image-only /exam view.
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? undefined,
            transcribedOptionImages: q.transcribedOptionImages ?? undefined,
            transcribedOptionTable: q.transcribedOptionTable ?? undefined,
            transcribedSubparts: q.transcribedSubparts ?? undefined,
            sourceQuestionId: q.id,
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
                syllabusTopic: q.syllabusTopic,
                transcribedStem: q.transcribedStem,
                transcribedOptions: q.transcribedOptions ?? undefined,
                transcribedOptionImages: q.transcribedOptionImages ?? undefined,
                transcribedOptionTable: q.transcribedOptionTable ?? undefined,
                transcribedSubparts: q.transcribedSubparts ?? undefined,
                sourceQuestionId: q.id,
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

  // Non-assign branches (retry extraction + field updates) still
  // require full paper access: ownership, assignee, linked parent of
  // the assignee, or admin. This is the original tightening from
  // commit e635fbeb — preserved here because score/markingStatus
  // edits etc. shouldn't be open to any signed-in user.
  const auth = await requireAccessToPaper(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
  if ("scheduledFor" in body) data.scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : new Date();
  if ("extractionStatus" in body) data.extractionStatus = body.extractionStatus || null;
  if ("visible" in body && typeof body.visible === "boolean") data.visible = body.visible;
  if ("skipPages" in body && Array.isArray(body.skipPages)) {
    // Merge skipPages into existing metadata
    const existing = await prisma.examPaper.findUnique({ where: { id }, select: { metadata: true } });
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
    data.metadata = { ...existingMeta, skipPages: body.skipPages };
  }
  if ("passagePages" in body && Array.isArray(body.passagePages)) {
    // Merge passagePages into existing metadata
    const existing = await prisma.examPaper.findUnique({ where: { id }, select: { metadata: true } });
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
    data.metadata = { ...existingMeta, passagePages: body.passagePages };
  }
  if ("metadata" in body && typeof body.metadata === "object" && body.metadata !== null && !("skipPages" in body) && !("passagePages" in body)) {
    // Direct metadata update (e.g. sectionOcrTexts)
    data.metadata = body.metadata;
  }
  // Parent's red-pen review annotations. Body shape: { reviewAnnotations:
  // { key: dataUrl | null } } — null clears that key. Merges into the
  // existing object so multiple passages/questions can be saved
  // independently without one overwriting the others.
  if ("reviewAnnotations" in body && typeof body.reviewAnnotations === "object" && body.reviewAnnotations !== null) {
    const existing = await prisma.examPaper.findUnique({ where: { id }, select: { reviewAnnotations: true } });
    const merged: Record<string, string> = { ...((existing?.reviewAnnotations as Record<string, string>) ?? {}) };
    for (const [k, v] of Object.entries(body.reviewAnnotations as Record<string, string | null>)) {
      if (v === null) delete merged[k]; else if (typeof v === "string") merged[k] = v;
    }
    data.reviewAnnotations = Object.keys(merged).length > 0 ? merged : Prisma.JsonNull;
  }

  const paper = await prisma.examPaper.update({ where: { id }, data });

  return NextResponse.json({ success: true, id: paper.id });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Caller must have access to the paper — was previously open to
  // any authenticated user.
  const auth = await requireAccessToPaper(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
        imageData: body.imageData || "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=", // 1x1 white pixel
        answer: null,
        answerImageData: null,
        pageIndex: refQuestion?.pageIndex ?? 0,
        orderIndex: insertOrder,
        yStartPct: null,
        yEndPct: null,
        marksAvailable: body.marksAvailable ?? null,
        syllabusTopic: body.syllabusTopic ?? null,
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Caller from session — was previously trusting ?userId= from the
  // query string, which a non-admin could spoof to "admin" to bypass
  // the master-paper delete guard below.
  const session = await requireSession();
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status });
  const requesterId = session.userId;
  const callerIsAdmin = session.isAdmin;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { paperType: true, assignedToId: true, completedAt: true, userId: true, sourceExamId: true },
  });

  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!callerIsAdmin) {
    // Check if requester is a parent linked to the assigned student
    let isLinkedParent = false;
    if (paper.assignedToId) {
      const link = await prisma.parentStudent.findFirst({
        where: { parentId: requesterId, studentId: paper.assignedToId },
      });
      isLinkedParent = !!link;
    }
    const isOwner = paper.userId === requesterId || paper.assignedToId === requesterId;

    if (
      paper.paperType === "quiz" ||
      paper.paperType === "focused" ||
      paper.paperType === "diagnostic" ||
      paper.paperType === "mastery"
    ) {
      // Owner, assigned student, or linked parent can delete.
      // Diagnostics are standalone (no sourceExamId) so they fall into
      // this branch instead of the clone path. Mastery quizzes are the
      // master-class checkpoint papers — same lifecycle as quiz/focused,
      // so the same delete permission applies.
      if (!isOwner && !isLinkedParent) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else if (paper.sourceExamId) {
      // Clone — owner or linked parent can delete
      if (!isOwner && !isLinkedParent) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      // Master/original paper — non-admin cannot delete
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Hard-delete the paper (quizzes, focused, clones)
  await prisma.examPaper.delete({ where: { id } });

  // Clean up submission files from disk
  try {
    const { promises: fs } = await import("fs");
    const path = await import("path");
    const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
    const subDir = path.join(VOLUME_PATH, "submissions", id);
    await fs.rm(subDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  return NextResponse.json({ success: true });
}
