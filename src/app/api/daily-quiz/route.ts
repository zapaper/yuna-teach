import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  return ans.trim().replace(/[().]/g, "").trim();
}

function isMcq(answer: string | null): boolean {
  const n = normalizeMcqAnswer(answer);
  return n === "1" || n === "2" || n === "3" || n === "4";
}

export async function POST(request: NextRequest) {
  const { userId, studentId, quizType } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
  };

  if (!userId || !quizType) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const targetStudentId = studentId || userId;

  // Get the student's level
  const student = await prisma.user.findUnique({
    where: { id: targetStudentId },
    select: { level: true },
  });
  const levelFilter = student?.level ? `Primary ${student.level}` : undefined;

  // Find all clean-extracted questions from master papers (Math, matching level)
  const allQuestions = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      answer: { not: null },
      examPaper: {
        sourceExamId: null,          // master papers only
        paperType: null,             // exclude focused tests / quizzes
        subject: { contains: "math", mode: "insensitive" },
        ...(levelFilter ? { level: levelFilter } : {}),
      },
    },
    select: {
      id: true,
      questionNum: true,
      imageData: true,
      answer: true,
      answerImageData: true,
      marksAvailable: true,
      syllabusTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedSubparts: true,
      diagramImageData: true,
      diagramBounds: true,
      examPaper: {
        select: { year: true, examType: true, school: true },
      },
    },
  });

  // Deduplicate by transcribedStem — keep only one per unique stem (last wins)
  const stemMap = new Map<string, typeof allQuestions[number]>();
  for (const q of allQuestions) {
    const stem = (q.transcribedStem ?? "").trim();
    if (!stem) continue; // skip empty stems
    stemMap.set(stem, q); // last one wins (latest saved)
  }
  const uniqueQuestions = [...stemMap.values()];

  // Split into MCQ and OEQ pools
  const mcqPool = uniqueQuestions.filter(q => isMcq(q.answer));
  const oeqPool = uniqueQuestions.filter(q => !isMcq(q.answer));

  // Shuffle
  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
  shuffle(mcqPool);
  shuffle(oeqPool);

  let selected: typeof allQuestions;
  if (quizType === "mcq") {
    if (mcqPool.length < 1) {
      return NextResponse.json({ error: "Not enough MCQ questions available" }, { status: 404 });
    }
    selected = mcqPool.slice(0, 20);
  } else {
    // mcq-oeq: 10 MCQ + 5 OEQ
    if (mcqPool.length < 1 && oeqPool.length < 1) {
      return NextResponse.json({ error: "Not enough questions available" }, { status: 404 });
    }
    selected = [...mcqPool.slice(0, 10), ...oeqPool.slice(0, 5)];
  }

  const totalMarks = selected.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
  const levelLabel = levelFilter ? `P${student!.level} ` : "";

  const paper = await prisma.examPaper.create({
    data: {
      title: `${levelLabel}Daily Quiz (${quizType === "mcq" ? "MCQ" : "MCQ + OEQ"})`,
      subject: "Mathematics",
      level: levelFilter || null,
      userId,
      assignedToId: targetStudentId,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: { quizType },
      questions: {
        create: selected.map((q, i) => {
          const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
          const sourceLabel = parts.length > 0 ? parts.join(" ") : null;
          return {
            questionNum: String(i + 1),
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            marksAvailable: q.marksAvailable ?? 1,
            syllabusTopic: q.syllabusTopic,
            elaboration: sourceLabel,
            pageIndex: 0,
            orderIndex: i,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? undefined,
            transcribedOptionImages: q.transcribedOptionImages ?? undefined,
            transcribedSubparts: q.transcribedSubparts ?? undefined,
            diagramImageData: q.diagramImageData,
            diagramBounds: q.diagramBounds ?? undefined,
          };
        }),
      },
    },
  });

  return NextResponse.json({ id: paper.id, questionCount: selected.length });
}
