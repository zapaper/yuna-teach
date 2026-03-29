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

  // Determine which exam types are appropriate based on current month
  // Jan-Mar: WA1 only | Apr-Jun: WA1, WA2 | Jul-Aug: WA1, WA2, WA3 | Sep-Dec: all
  const currentMonth = new Date().getMonth() + 1; // 1-12
  let allowedExamTypes: string[] | null = null; // null = allow all
  if (currentMonth <= 3) {
    allowedExamTypes = ["WA1"];
  } else if (currentMonth <= 6) {
    allowedExamTypes = ["WA1", "WA2", "SA1"];  // SA1 covers WA1+WA2 scope
  } else if (currentMonth <= 8) {
    allowedExamTypes = ["WA1", "WA2", "WA3", "SA1"];
  }
  // Sep-Dec: all types allowed including SA2, Prelim, End of Year etc.

  const questionWhere = (lf: string | null, examTypeFilter: string[] | null) => ({
    transcribedStem: { not: null as null },
    answer: { not: null as null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subject === "science" ? "science" : "math", mode: "insensitive" as const },
      ...(lf ? { level: lf } : {}),
      ...(examTypeFilter ? { examType: { in: examTypeFilter } } : {}),
    },
  });

  const questionSelect = {
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
  };

  // Find all clean-extracted questions from master papers (matching level + semester)
  const allQuestions = await prisma.examQuestion.findMany({
    where: questionWhere(levelFilter ?? null, allowedExamTypes),
    select: questionSelect,
  });

  type Q = typeof allQuestions[number];

  // Strip trailing letter(s) from a question number to get the base, e.g. "35ab" → "35", "35c" → "35", "12" → "12"
  function baseNum(questionNum: string) {
    return questionNum.replace(/[a-zA-Z]+$/, "");
  }

  function buildPools(questions: Q[]) {
    // ── MCQ pool: deduplicate by stem ──────────────────────────────────────
    const mcqStemMap = new Map<string, Q>();
    for (const q of questions) {
      if (!isMcq(q.answer)) continue;
      const stem = (q.transcribedStem ?? "").trim();
      if (!stem) continue;
      mcqStemMap.set(stem, q);
    }

    // ── OEQ pool: group by (paperId, baseNum), deduplicate by lead stem ────
    const oeqGroupMap = new Map<string, Q[]>();
    for (const q of questions) {
      if (isMcq(q.answer)) continue;
      const stem = (q.transcribedStem ?? "").trim();
      if (!stem) continue;
      const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
      if (!oeqGroupMap.has(key)) oeqGroupMap.set(key, []);
      oeqGroupMap.get(key)!.push(q);
    }
    for (const group of oeqGroupMap.values()) {
      group.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
    }
    const oeqLeadStemMap = new Map<string, Q[]>();
    for (const group of oeqGroupMap.values()) {
      const leadStem = (group[0].transcribedStem ?? "").trim();
      if (!leadStem) continue;
      oeqLeadStemMap.set(leadStem, group);
    }

    return { mcqPool: [...mcqStemMap.values()], oeqPool: [...oeqLeadStemMap.values()] };
  }

  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);

  const { mcqPool: mcqCurrent, oeqPool: oeqCurrent } = buildPools(allQuestions);
  shuffle(mcqCurrent);
  shuffle(oeqCurrent);

  const mcqTarget = quizType === "mcq" ? 20 : 10;
  const oeqTarget = 5;

  // Top up from level-1 if current level doesn't have enough
  let mcqPool = mcqCurrent;
  let oeqPool = oeqCurrent;
  if (student?.level && student.level > 1 && (mcqPool.length < mcqTarget || oeqPool.length < oeqTarget)) {
    const prevLevelFilter = `Primary ${student.level - 1}`;
    const prevLevelQuestions = await prisma.examQuestion.findMany({
      where: questionWhere(prevLevelFilter, allowedExamTypes),
      select: questionSelect,
    });
    const { mcqPool: mcqPrev, oeqPool: oeqPrev } = buildPools(prevLevelQuestions);
    shuffle(mcqPrev);
    shuffle(oeqPrev);
    // Append level-1 questions after current level (current level has priority)
    mcqPool = [...mcqCurrent, ...mcqPrev];
    oeqPool = [...oeqCurrent, ...oeqPrev];
  }

  // Merge a group of OEQ question records into one combined question for the quiz
  function mergeOeqGroup(group: Q[]) {
    const first = group[0];
    // Combine all subparts across parts, stripping sentinel entries
    type Subpart = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));

      // If this is NOT the first question in the group and it has its own diagram,
      // attach that diagram to its subparts so they display it in the quiz
      if (q !== first && q.diagramImageData && realSubs.length > 0) {
        // Only attach to the first subpart of this group member (avoid repeating)
        const diagramData = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
        const enriched = realSubs.map((sp, idx) =>
          idx === 0 && !sp.refImageBase64
            ? { ...sp, refImageBase64: diagramData }
            : sp
        );
        allSubparts.push(...enriched);
      } else {
        allSubparts.push(...realSubs);
      }
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

    // Use the first question's diagram, or fall back to any later question's diagram
    const diagramImageData = first.diagramImageData
      || group.find(q => q.diagramImageData)?.diagramImageData
      || null;

    const combinedAnswer = [...new Set(group.map(q => q.answer).filter(Boolean))].join("\n");

    return {
      ...first,
      answer: combinedAnswer || first.answer,
      transcribedStem: combinedStem,
      transcribedSubparts: allSubparts.length > 0 ? [...allSubparts, ...sentinels] : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData,
    };
  }

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
  const totalMarks = allSelected.reduce((sum, q) => sum + (isMcq(q.answer) ? 2 : (q.marksAvailable ?? 1)), 0);
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
          marksAvailable: isMcq(q.answer) ? 2 : (q.marksAvailable ?? 1),
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData,
          diagramBounds: q.diagramBounds ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
  });

  return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
}
