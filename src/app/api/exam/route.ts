import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  const role = request.nextUrl.searchParams.get("role");

  let where = undefined;
  if (userId) {
    if (role === "STUDENT") {
      where = { assignedToId: userId };
    } else {
      where = { userId };
    }
  }

  const papers = await prisma.examPaper.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { questions: true } },
      assignedTo: { select: { id: true, name: true } },
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
    })),
  });
}
