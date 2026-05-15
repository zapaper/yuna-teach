import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { transcribeScienceMcqQuestion } from "@/lib/gemini";

// POST { questionId } → runs the science MCQ extractor on the saved image
// and returns whatever Gemini produces (optionTable, options, stem,
// diagram). UI inspects whether optionTable is non-null and offers
// Apply / Skip per question.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { questionId } = await request.json();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { imageData: true },
  });
  if (!q || !q.imageData) return NextResponse.json({ error: "No image data" }, { status: 404 });

  const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
  try {
    const r = await transcribeScienceMcqQuestion(base64);
    return NextResponse.json({
      stem: r.stem,
      optionTable: r.optionTable,
      options: r.options,
    });
  } catch (err) {
    console.error("[mcq-table-candidates/extract] failed", err);
    return NextResponse.json({ error: "Extract failed" }, { status: 500 });
  }
}
