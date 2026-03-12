import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { transcribeMathMcqQuestion, transcribeMathOpenEndedQuestion } from "@/lib/gemini";

/** Normalize answer string to bare digit, e.g. "(2)" → "2" */
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
    select: { id: true, questionNum: true, answer: true, imageData: true, syllabusTopic: true, marksAvailable: true },
  });

  console.log(`[transcribe] Paper ${id}: transcribing ${questions.length} questions (MCQ + open-ended)`);

  const results = await Promise.all(
    questions.map(async (q) => {
      const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
      const mcq = isMathMcq(q.answer);
      try {
        if (mcq) {
          const transcribed = await transcribeMathMcqQuestion(base64);
          return {
            type: "mcq" as const,
            questionNum: q.questionNum,
            answer: normalizeMcqAnswer(q.answer),
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: transcribed.options,
            subparts: null,
            error: null,
          };
        } else {
          const transcribed = await transcribeMathOpenEndedQuestion(base64);
          return {
            type: "open" as const,
            questionNum: q.questionNum,
            answer: q.answer ?? "",
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: null,
            subparts: transcribed.subparts,
            error: null,
          };
        }
      } catch (err) {
        console.error(`[transcribe] Q${q.questionNum} failed:`, err);
        return {
          type: mcq ? "mcq" as const : "open" as const,
          questionNum: q.questionNum,
          answer: mcq ? normalizeMcqAnswer(q.answer) : (q.answer ?? ""),
          syllabusTopic: q.syllabusTopic,
          marksAvailable: q.marksAvailable,
          stem: null,
          options: null,
          subparts: null,
          error: err instanceof Error ? err.message : "Failed",
        };
      }
    })
  );

  return NextResponse.json({ questions: results });
}
