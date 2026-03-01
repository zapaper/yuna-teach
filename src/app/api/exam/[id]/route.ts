import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
          ? { id: true, questionNum: true, answer: true, orderIndex: true, pageIndex: true }
          : undefined,
      },
      assignedTo: { select: { id: true, name: true } },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...paper,
    assignedToName: paper.assignedTo?.name ?? null,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Pick only the fields we allow updating
  const data: Record<string, unknown> = {};
  if ("assignedToId" in body) data.assignedToId = body.assignedToId || null;
  if ("score" in body) data.score = body.score ?? null;
  if ("completedAt" in body)
    data.completedAt = body.completedAt ? new Date(body.completedAt) : null;
  if ("totalMarks" in body) data.totalMarks = body.totalMarks || null;

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
