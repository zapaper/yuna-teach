import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";

// Sets up the App Review demo accounts:
//   parent  — review@markforyou.com  / 1234
//   student — review-student          / 1234  (linked to the parent)
//
// Then clones the most recent 10 completed quizzes/focused-tests Emily
// did onto review-student so the reviewer immediately sees populated
// progress + history. Idempotent — running again refreshes the clone
// set without duplicating the accounts.

const PARENT_EMAIL = "review@markforyou.com";
const PARENT_PASSWORD = "1234";
const STUDENT_USERNAME = "review-student";
const STUDENT_PASSWORD = "1234";
const CLONE_COUNT = 10;

(async () => {
  // 1. Locate Emily Lim — the source for paper cloning.
  const emily = await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      OR: [
        { name: { equals: "Emily lim", mode: "insensitive" } },
        { name: { equals: "Emily Lim", mode: "insensitive" } },
        { displayName: { equals: "Emily lim", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, level: true },
  });
  if (!emily) {
    console.error("Could not find Emily Lim. Aborting.");
    process.exit(1);
  }
  console.log(`Source student: ${emily.name} (${emily.id}) P${emily.level}`);

  // 2. Upsert the parent account.
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
    console.log(`Created parent ${parent.id}`);
  } else {
    // Ensure password matches what we promised Apple, in case it drifted.
    parent = await prisma.user.update({
      where: { id: parent.id },
      data: { password: PARENT_PASSWORD, emailVerified: true, role: "PARENT" },
    });
    console.log(`Reusing parent ${parent.id}`);
  }

  // 3. Upsert the student account. `name` is the login username; it's
  //    unique only by convention, not by DB constraint, so look it up
  //    explicitly and reuse if present.
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
    console.log(`Created student ${student.id}`);
  } else {
    student = await prisma.user.update({
      where: { id: student.id },
      data: { password: STUDENT_PASSWORD, level: emily.level ?? 6, role: "STUDENT" },
    });
    console.log(`Reusing student ${student.id}`);
  }

  // 4. Link them.
  await prisma.parentStudent.upsert({
    where: { parentId_studentId: { parentId: parent.id, studentId: student.id } },
    create: { parentId: parent.id, studentId: student.id },
    update: {},
  });
  console.log(`Linked parent ↔ student`);

  // 5. Pull Emily's most-recent 10 completed quiz/focused papers.
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
  console.log(`Pulled ${sourcePapers.length} papers from Emily.`);

  // 6. Wipe any previous demo clones for this student so re-runs don't
  //    accumulate duplicates.
  const existingClones = await prisma.examPaper.findMany({
    where: { assignedToId: student.id, userId: parent.id },
    select: { id: true },
  });
  if (existingClones.length > 0) {
    await prisma.examPaper.deleteMany({
      where: { id: { in: existingClones.map(c => c.id) } },
    });
    console.log(`Wiped ${existingClones.length} previous demo clones.`);
  }

  // 7. Clone each paper. Preserve all marking data so the dashboards
  //    immediately render with scores, AI feedback, topic stats, etc.
  for (const src of sourcePapers) {
    // Strip server-managed fields; let Prisma assign new ids/timestamps.
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
        // Preserve provenance — the master is whatever Emily's clone
        // pointed at, falling back to her clone itself if no master.
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
    console.log(`  cloned "${src.title}" → ${newPaper.id}`);
  }

  console.log("\nDone.");
  console.log(`  Parent: ${PARENT_EMAIL} / ${PARENT_PASSWORD}  →  ${parent.id}`);
  console.log(`  Student: ${STUDENT_USERNAME} / ${STUDENT_PASSWORD}  →  ${student.id}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
