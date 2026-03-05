import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  const role = request.nextUrl.searchParams.get("role");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any = undefined;
  if (userId) {
    if (role === "STUDENT") {
      where = { assignedToId: userId };
    } else {
      // Parents see only master papers (exclude clones and focused tests)
      where = { userId, sourceExamId: null, paperType: null };
    }
  }

  const papers = await prisma.examPaper.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { questions: true, clones: true } },
      assignedTo: { select: { id: true, name: true } },
      questions: { where: { syllabusTopic: { not: null } }, select: { id: true }, take: 1 },
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
      syllabusTagged: p.questions.length > 0,
    })),
  });
}
