import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any = undefined;
  let linkedStudentIds: string[] | null = null; // null = no filter (admin), [] = no students
  if (userId) {
    // Determine role from DB
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const role = user?.role;

    if (role === "STUDENT") {
      where = { assignedToId: userId };
    } else {
      // Parents see master papers + focused tests (exclude clones)
      // Filter to only levels matching their linked students
      const links = await prisma.parentStudent.findMany({
        where: { parentId: userId },
        include: { student: { select: { id: true, level: true } } },
      });
      linkedStudentIds = links.map((l) => l.student.id);
      const studentLevels = links
        .map((l) => l.student.level)
        .filter((v): v is number => v != null);

      // Check if this parent is admin
      const parentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const isAdminUser = parentUser?.name?.toLowerCase() === "admin";

      if (studentLevels.length > 0) {
        // Match levels with various formats: "Primary 5", "Pr 5", "P5", etc.
        const levelConditions = studentLevels.flatMap((n) => [
          { level: { contains: String(n) } },
        ]);
        if (isAdminUser) {
          // Admin sees all master papers; focused tests only if admin created them for themselves
          where = {
            OR: [
              { sourceExamId: null, paperType: null },
              { sourceExamId: null, paperType: "focused", userId, assignedToId: null },
              { sourceExamId: null, paperType: "focused", userId, assignedToId: userId },
              { paperType: "focused", assignedToId: { in: linkedStudentIds } },
              { paperType: "quiz", assignedToId: { in: linkedStudentIds } },
              { paperType: "diagnostic", assignedToId: { in: linkedStudentIds } },
              // Also include regular paper clones assigned to linked students
              { sourceExamId: { not: null }, paperType: null, assignedToId: { in: linkedStudentIds } },
            ],
          };
        } else {
          // Non-admin parents see admin's master papers + own focused tests + student clones
          const adminUser = await prisma.user.findFirst({
            where: { name: { equals: "admin", mode: "insensitive" } },
            select: { id: true },
          });
          where = {
            OR: [
              {
                sourceExamId: null,
                paperType: null,
                visible: true,
                OR: levelConditions,
                ...(adminUser ? { userId: adminUser.id } : {}),
              },
              { sourceExamId: null, paperType: "focused", userId },
              { paperType: "focused", assignedToId: { in: linkedStudentIds } },
              { paperType: "quiz", assignedToId: { in: linkedStudentIds } },
              { paperType: "diagnostic", assignedToId: { in: linkedStudentIds } },
              // Also include regular paper clones assigned to linked students
              { sourceExamId: { not: null }, paperType: null, assignedToId: { in: linkedStudentIds } },
            ],
          };
        }
      } else if (isAdminUser) {
        // Admin with no linked students — still show all master papers
        where = {
          sourceExamId: null,
          OR: [
            { paperType: null },
            { paperType: "focused", userId, assignedToId: null },
            { paperType: "focused", userId, assignedToId: userId },
          ],
        };
        // linkedStudentIds stays [] so clones include is filtered to none
      } else {
        // No linked students — show no papers
        where = { id: "none" };
      }
    }
  }

  // Auto-fail papers stuck in "processing" for more than 15 minutes (based on updatedAt)
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.examPaper.updateMany({
    where: {
      extractionStatus: "processing",
      updatedAt: { lt: staleThreshold },
    },
    data: { extractionStatus: "failed" },
  });

  const papers = await prisma.examPaper.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { questions: true, clones: true } },
      assignedTo: { select: { id: true, name: true } },
      questions: {
        where: { OR: [{ syllabusTopic: { not: null } }, { transcribedStem: { not: null } }] },
        select: { id: true, transcribedStem: true },
        take: 1,
      },
      clones: {
        where: linkedStudentIds !== null ? { assignedToId: { in: linkedStudentIds } } : undefined,
        select: {
          id: true,
          markingStatus: true,
          assignedToId: true,
          createdAt: true,
          _count: { select: { questions: { where: { flagged: true } } } },
        },
      },
    },
  });

  return NextResponse.json({
    papers: papers.map((p) => ({
      id: p.id,
      title: p.title,
      school: p.school,
      level: p.level,
      subject: p.subject,
      questionCount: p._count.questions,
      createdAt: p.createdAt.toISOString(),
      scheduledFor: p.scheduledFor?.toISOString() ?? null,
      assignedToId: p.assignedToId,
      assignedToName: p.assignedTo?.name ?? null,
      completedAt: p.completedAt?.toISOString() ?? null,
      markingStatus: p.markingStatus ?? null,
      extractionStatus: p.extractionStatus ?? null,
      assignmentCount: p._count.clones,
      // Per-student last-assigned timestamp lookup. UI shows the entry for
      // the currently selected student so the parent sees 'Last assigned
      // 3 days ago' inline next to the Assign button.
      lastAssignedByStudent: Object.fromEntries(
        Array.from(
          p.clones.reduce<Map<string, Date>>((acc, c) => {
            if (!c.assignedToId) return acc;
            const cur = acc.get(c.assignedToId);
            if (!cur || c.createdAt > cur) acc.set(c.assignedToId, c.createdAt);
            return acc;
          }, new Map())
        ).map(([k, v]) => [k, v.toISOString()])
      ),
      score: p.score ?? null,
      totalMarks: p.totalMarks ?? null,
      paperType: p.paperType ?? null,
      examType: p.examType ?? null,
      sourceExamId: p.sourceExamId ?? null,
      syllabusTagged: p.questions.length > 0,
      cleanExtracted: p.questions.some(q => !!q.transcribedStem),
      flaggedCount: p.clones.reduce((sum, c) => sum + c._count.questions, 0),
      unreleasedAssignmentCount: p.clones.filter((c) => c.markingStatus !== "released").length,
      pendingReviewCount: p.clones.filter((c) => c.markingStatus === "complete").length,
      instantFeedback: p.instantFeedback,
      visible: p.visible,
      timeSpentSeconds: p.timeSpentSeconds,
    })),
  });
}
