import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { transcribeMathMcqQuestion } from "@/lib/gemini";

/** Normalize answer string to bare digit, e.g. "(2)" → "2", "3." → "3" */
function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  return ans.trim().replace(/[().]/g, "").trim();
}

function isMathMcq(answer: string | null): boolean {
  const n = normalizeMcqAnswer(answer);
  return n === "1" || n === "2" || n === "3" || n === "4";
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { subject: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const subjectLower = (paper.subject ?? "").toLowerCase();
  if (!subjectLower.includes("math")) {
    return NextResponse.json({ error: "Only Math papers supported for now" }, { status: 400 });
  }

  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, answer: true, imageData: true, syllabusTopic: true },
  });

  const mcqQuestions = questions.filter(q => isMathMcq(q.answer));

  if (mcqQuestions.length === 0) {
    return NextResponse.json({ questions: [], message: "No MCQ questions detected in this paper" });
  }

  console.log(`[transcribe-mcq] Paper ${id}: transcribing ${mcqQuestions.length} MCQ questions`);

  const results = await Promise.all(
    mcqQuestions.map(async (q) => {
      try {
        // Strip data URI prefix if present
        const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
        const transcribed = await transcribeMathMcqQuestion(base64);
        return {
          questionNum: q.questionNum,
          answer: normalizeMcqAnswer(q.answer),
          syllabusTopic: q.syllabusTopic,
          stem: transcribed.stem,
          options: transcribed.options,
          error: null,
        };
      } catch (err) {
        console.error(`[transcribe-mcq] Q${q.questionNum} failed:`, err);
        return {
          questionNum: q.questionNum,
          answer: normalizeMcqAnswer(q.answer),
          syllabusTopic: q.syllabusTopic,
          stem: null,
          options: null,
          error: err instanceof Error ? err.message : "Failed",
        };
      }
    })
  );

  return NextResponse.json({ questions: results });
}
