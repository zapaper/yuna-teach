import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import {
  detectQuestionType,
  transcribeMathMcqQuestion,
  transcribeMathOpenEndedQuestion,
  transcribeScienceMcqQuestion,
  transcribeScienceOpenEndedQuestion,
} from "@/lib/gemini";

// POST { questionId } → runs Gemini OCR on the question's imageData and returns
// { stem, options, subparts } WITHOUT saving. Admin then reviews and hits Save in the UI.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { questionId } = await request.json();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { imageData: true, examPaper: { select: { subject: true } } },
  });
  if (!q || !q.imageData) return NextResponse.json({ error: "No image data" }, { status: 404 });

  const subject = (q.examPaper.subject ?? "").toLowerCase();
  const isScience = subject.includes("science");
  const isMath = subject.includes("math");
  if (!isMath && !isScience) {
    return NextResponse.json({ error: "OCR extract is only supported for Math and Science questions" }, { status: 400 });
  }

  const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");

  try {
    const detectedType = await detectQuestionType(base64);
    if (detectedType === "mcq") {
      const r = await (isScience ? transcribeScienceMcqQuestion(base64) : transcribeMathMcqQuestion(base64));
      return NextResponse.json({ type: "mcq", stem: r.stem, options: r.options });
    } else {
      const r = await (isScience ? transcribeScienceOpenEndedQuestion(base64) : transcribeMathOpenEndedQuestion(base64));
      return NextResponse.json({ type: "open", stem: r.stem, subparts: r.subparts });
    }
  } catch (err) {
    console.error("[broken-questions/transcribe] failed", err);
    return NextResponse.json({ error: "OCR failed" }, { status: 500 });
  }
}
