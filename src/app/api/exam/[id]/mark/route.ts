import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { markExamPaper } from "@/lib/marking";

// GET /api/exam/[id]/mark
// Returns { markingStatus, questions: [{ id, questionNum, marksAwarded, marksAvailable, markingNotes }] }
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      markingStatus: true,
      score: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true,
          questionNum: true,
          marksAwarded: true,
          marksAvailable: true,
          markingNotes: true,
        },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(paper);
}

// POST /api/exam/[id]/mark
// Triggers AI marking. Runs synchronously and returns when done.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { markingStatus: true, completedAt: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!paper.completedAt) {
    return NextResponse.json(
      { error: "Paper has not been submitted yet" },
      { status: 400 }
    );
  }

  if (paper.markingStatus === "in_progress") {
    return NextResponse.json({ status: "in_progress" });
  }

  try {
    await markExamPaper(id);
    return NextResponse.json({ success: true, status: "complete" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Marking failed: ${msg}`, status: "failed" },
      { status: 500 }
    );
  }
}
