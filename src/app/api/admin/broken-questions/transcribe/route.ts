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
//
// Logging on every gate so "nothing happens, no server log" reports
// can be diagnosed without guesswork.
export async function POST(request: NextRequest) {
  const t0 = Date.now();
  console.log("[broken-questions/transcribe] POST received");
  if (!(await isSessionAdmin())) {
    console.warn("[broken-questions/transcribe] 403 — not an admin session");
    return NextResponse.json({ error: "Forbidden — sign in as admin" }, { status: 403 });
  }
  const { questionId } = await request.json();
  if (!questionId) {
    console.warn("[broken-questions/transcribe] 400 — questionId missing in body");
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }
  console.log(`[broken-questions/transcribe] questionId=${questionId}`);

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { imageData: true, examPaper: { select: { subject: true, title: true } } },
  });
  if (!q) {
    console.warn(`[broken-questions/transcribe] 404 — question ${questionId} not found`);
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }
  if (!q.imageData) {
    console.warn(`[broken-questions/transcribe] 404 — question ${questionId} has no imageData`);
    return NextResponse.json({ error: "No image data on this question" }, { status: 404 });
  }

  const subject = (q.examPaper.subject ?? "").toLowerCase();
  const isScience = subject.includes("science");
  const isMath = subject.includes("math");
  console.log(`[broken-questions/transcribe] paper="${q.examPaper.title}" subject="${q.examPaper.subject}" isMath=${isMath} isScience=${isScience}`);
  if (!isMath && !isScience) {
    console.warn(`[broken-questions/transcribe] 400 — subject "${q.examPaper.subject}" is neither Math nor Science`);
    return NextResponse.json({ error: `OCR extract is only supported for Math and Science questions (this paper's subject is "${q.examPaper.subject ?? "(unset)"}")` }, { status: 400 });
  }

  const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");

  try {
    const detectedType = await detectQuestionType(base64);
    console.log(`[broken-questions/transcribe] detected type: ${detectedType} (${Date.now() - t0}ms)`);
    if (detectedType === "mcq") {
      if (isScience) {
        const r = await transcribeScienceMcqQuestion(base64);
        console.log(`[broken-questions/transcribe] science MCQ done in ${Date.now() - t0}ms; stem chars=${r.stem.length}`);
        return NextResponse.json({ type: "mcq", stem: r.stem, options: r.options, optionTable: r.optionTable });
      }
      const r = await transcribeMathMcqQuestion(base64);
      console.log(`[broken-questions/transcribe] math MCQ done in ${Date.now() - t0}ms; stem chars=${r.stem.length}`);
      return NextResponse.json({ type: "mcq", stem: r.stem, options: r.options });
    } else {
      const r = await (isScience ? transcribeScienceOpenEndedQuestion(base64) : transcribeMathOpenEndedQuestion(base64));
      console.log(`[broken-questions/transcribe] ${isScience ? "science" : "math"} OEQ done in ${Date.now() - t0}ms; stem chars=${r.stem.length}; subparts=${r.subparts?.length ?? 0}`);
      return NextResponse.json({ type: "open", stem: r.stem, subparts: r.subparts });
    }
  } catch (err) {
    console.error(`[broken-questions/transcribe] failed after ${Date.now() - t0}ms:`, err);
    return NextResponse.json({ error: `OCR failed: ${(err as Error).message ?? err}` }, { status: 500 });
  }
}
