import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/exam/[id]/unassign
// Body: { studentId }
// Removes the clone of this master paper assigned to the given student,
// as long as it hasn't been completed yet.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { studentId } = await request.json();
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }

  const clone = await prisma.examPaper.findFirst({
    where: { sourceExamId: id, assignedToId: studentId },
    select: { id: true, completedAt: true },
  });
  if (!clone) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  if (clone.completedAt) {
    return NextResponse.json({ error: "Cannot remove a completed paper" }, { status: 400 });
  }

  await prisma.examPaper.delete({ where: { id: clone.id } });
  return NextResponse.json({ success: true });
}
