import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/exam/release-perfect
// Releases all "complete" papers with 100% score for a given student
export async function POST(request: NextRequest) {
  const { studentId } = await request.json();
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }

  // Find all complete (not yet released) papers assigned to this student
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      markingStatus: "complete",
    },
    select: {
      id: true,
      score: true,
      questions: {
        select: { marksAvailable: true },
      },
    },
  });

  let released = 0;
  for (const paper of papers) {
    const totalAvailable = paper.questions.reduce((sum, q) => sum + (q.marksAvailable ?? 0), 0);
    if (totalAvailable > 0 && (paper.score ?? 0) >= totalAvailable) {
      await prisma.examPaper.update({
        where: { id: paper.id },
        data: { markingStatus: "released" },
      });
      released++;
    }
  }

  return NextResponse.json({ released });
}
