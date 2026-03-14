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
  const { userId, studentId, quizType, subject } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
    subject?: "math" | "science";
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
        subject: { contains: subject === "science" ? "science" : "math", mode: "insensitive" },
        ...(levelFilter ? { level: levelFilter } : {}),
      },
    },
    select: {
      id: true,
      questionNum: true,
      examPaperId: true,
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
        select: { id: true, year: true, examType: true, school: true },
      },
    },
  });

  type Q = typeof allQuestions[number];

  // Strip trailing letter(s) from a question number to get the base, e.g. "35ab" → "35", "35c" → "35", "12" → "12"
  function baseNum(questionNum: string) {
    return questionNum.replace(/[a-zA-Z]+$/, "");
  }

  // ── MCQ pool: deduplicate by stem ────────────────────────────────────────
  const mcqStemMap = new Map<string, Q>();
  for (const q of allQuestions) {
    if (!isMcq(q.answer)) continue;
    const stem = (q.transcribedStem ?? "").trim();
    if (!stem) continue;
    mcqStemMap.set(stem, q);
  }
  const mcqPool = [...mcqStemMap.values()];

  // ── OEQ pool: group by (paperId, baseNum) then deduplicate groups by lead stem ─
  // Step 1: collect all OEQ, grouped by paper+baseNum
  const oeqGroupMap = new Map<string, Q[]>();
  for (const q of allQuestions) {
    if (isMcq(q.answer)) continue;
    const stem = (q.transcribedStem ?? "").trim();
    if (!stem) continue;
    const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
    if (!oeqGroupMap.has(key)) oeqGroupMap.set(key, []);
    oeqGroupMap.get(key)!.push(q);
  }

  // Sort each group by questionNum so parts are in order (35a, 35b, 35c…)
  for (const group of oeqGroupMap.values()) {
    group.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }

  // Step 2: deduplicate groups by the lead question's stem (last paper wins)
  const oeqLeadStemMap = new Map<string, Q[]>();
  for (const group of oeqGroupMap.values()) {
    const leadStem = (group[0].transcribedStem ?? "").trim();
    if (!leadStem) continue;
    oeqLeadStemMap.set(leadStem, group);
  }
  const oeqPool = [...oeqLeadStemMap.values()];

  // Merge a group of OEQ question records into one combined question for the quiz
  function mergeOeqGroup(group: Q[]) {
    const first = group[0];
    // Combine all subparts across parts, stripping sentinel entries
    type Subpart = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      allSubparts.push(...subs.filter(s => !s.label.startsWith("_")));
    }
    // Collect sentinels from all parts
    const sentinels: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      sentinels.push(...subs.filter(s => s.label.startsWith("_")));
    }
    // Combine stems: use first stem; if later parts have a different stem (continuation context), append
    const stems = group.map(q => (q.transcribedStem ?? "").trim()).filter(Boolean);
    const combinedStem = [...new Set(stems)].join("\n");

    return {
      ...first,
      transcribedStem: combinedStem,
      transcribedSubparts: allSubparts.length > 0 ? [...allSubparts, ...sentinels] : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      // sourceLabel uses first question's paper info
    };
  }

  // Shuffle
  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
  shuffle(mcqPool);
  shuffle(oeqPool);

  type MergedQ = ReturnType<typeof mergeOeqGroup>;
  let selectedMcq: Q[];
  let selectedOeq: MergedQ[];

  if (quizType === "mcq") {
    if (mcqPool.length < 1) {
      return NextResponse.json({ error: "Not enough MCQ questions available" }, { status: 404 });
    }
    selectedMcq = mcqPool.slice(0, 20);
    selectedOeq = [];
  } else {
    if (mcqPool.length < 1 && oeqPool.length < 1) {
      return NextResponse.json({ error: "Not enough questions available" }, { status: 404 });
    }
    selectedMcq = mcqPool.slice(0, 10);
    selectedOeq = oeqPool.slice(0, 5).map(mergeOeqGroup);
  }

  const allSelected = [...selectedMcq, ...selectedOeq];
  const totalMarks = allSelected.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
  const levelLabel = levelFilter ? `P${student!.level} ` : "";

  const paper = await prisma.examPaper.create({
    data: {
      title: `${levelLabel}Daily Quiz – ${subject === "science" ? "Science" : "Math"} (${quizType === "mcq" ? "MCQ" : "MCQ + OEQ"})`,
      subject: subject === "science" ? "Science" : "Mathematics",
      level: levelFilter || null,
      userId,
      assignedToId: targetStudentId,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        quizType,
        sourceLabels: Object.fromEntries(
          allSelected.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          })
        ),
      },
      questions: {
        create: allSelected.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: q.marksAvailable ?? 1,
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData,
          diagramBounds: q.diagramBounds ?? undefined,
        })),
      },
    },
  });

  return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
}
