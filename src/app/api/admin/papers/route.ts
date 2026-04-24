import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (user?.name?.toLowerCase() !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      school: true,
      year: true,
      examType: true,
      paperType: true,
      visible: true,
      extractionStatus: true,
      createdAt: true,
      userId: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    papers: papers.map(p => ({
      id: p.id,
      title: p.title,
      subject: p.subject,
      level: p.level,
      school: p.school,
      year: p.year,
      examType: p.examType,
      paperType: p.paperType,
      visible: p.visible,
      extractionStatus: p.extractionStatus,
      createdAt: p.createdAt.toISOString(),
      questionCount: p._count.questions,
      assignmentCount: p._count.clones,
      creatorId: p.userId,
      creatorName: p.user?.name ?? null,
      creatorEmail: p.user?.email ?? null,
    })),
  });
}
