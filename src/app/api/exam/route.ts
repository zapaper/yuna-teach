import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any = undefined;
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
        include: { student: { select: { level: true } } },
      });
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
        const levelStrings = studentLevels.map((n) => `Primary ${n}`);
        if (isAdminUser) {
          // Admin sees own master papers (matching levels + processing) + own focused tests
          where = {
            userId,
            sourceExamId: null,
            OR: [
              { paperType: null, OR: [{ level: { in: levelStrings } }, { level: null }] },
              { paperType: "focused" },
            ],
          };
        } else {
          // Non-admin parents see admin's master papers + own focused tests
          const adminUser = await prisma.user.findFirst({
            where: { name: { equals: "admin", mode: "insensitive" } },
            select: { id: true },
          });
          where = {
            sourceExamId: null,
            OR: [
              {
                paperType: null,
                level: { in: levelStrings },
                ...(adminUser ? { userId: adminUser.id } : {}),
              },
              { paperType: "focused", userId },
            ],
          };
        }
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
      questions: { where: { syllabusTopic: { not: null } }, select: { id: true }, take: 1 },
      clones: {
        select: {
          id: true,
          markingStatus: true,
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
      assignedToId: p.assignedToId,
      assignedToName: p.assignedTo?.name ?? null,
      completedAt: p.completedAt?.toISOString() ?? null,
      markingStatus: p.markingStatus ?? null,
      extractionStatus: p.extractionStatus ?? null,
      assignmentCount: p._count.clones,
      score: p.score ?? null,
      totalMarks: p.totalMarks ?? null,
      paperType: p.paperType ?? null,
      examType: p.examType ?? null,
      syllabusTagged: p.questions.length > 0,
      flaggedCount: p.clones.reduce((sum, c) => sum + c._count.questions, 0),
      unreleasedAssignmentCount: p.clones.filter((c) => c.markingStatus !== "released").length,
      pendingReviewCount: p.clones.filter((c) => c.markingStatus === "complete").length,
    })),
  });
}
