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
  const { userId, studentId, quizType, subject, englishOeqSections } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
    subject?: "math" | "science" | "english";
    englishOeqSections?: string[]; // e.g. ["grammar-cloze", "editing", "synthesis"]
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

  // Determine which exam types are appropriate based on current date
  // Jan - Apr: WA1 only | May - Jul 14: WA1, WA2, SA1 | Jul 15 - Aug: WA1, WA2, WA3, SA1 | Sep-Dec: all
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentDay = now.getDate();
  let allowedExamTypes: string[] | null = null; // null = allow all
  if (currentMonth <= 4) {
    allowedExamTypes = ["WA1"];
  } else if (currentMonth < 7 || (currentMonth === 7 && currentDay <= 14)) {
    allowedExamTypes = ["WA1", "WA2", "SA1"];  // SA1 covers WA1+WA2 scope
  } else if (currentMonth <= 8) {
    allowedExamTypes = ["WA1", "WA2", "WA3", "SA1"];
  }
  // Sep-Dec: all types allowed including SA2, Prelim, End of Year etc.

  const subjectFilter = subject === "science" ? "science" : subject === "english" ? "english" : "math";

  const questionWhere = (lf: string | null, examTypeFilter: string[] | null) => ({
    transcribedStem: { not: null as null },
    answer: { not: null as null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subjectFilter, mode: "insensitive" as const },
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

  // Get source question IDs already used in this student's previous quizzes
  const previousQuizQuestions = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: { not: null },
      examPaper: { assignedToId: targetStudentId, paperType: "quiz" },
    },
    select: { sourceQuestionId: true },
  });
  const usedSourceIds = new Set(previousQuizQuestions.map(q => q.sourceQuestionId!));

  // Find all clean-extracted questions from master papers (matching level + semester)
  const allQuestions = await prisma.examQuestion.findMany({
    where: questionWhere(levelFilter ?? null, allowedExamTypes),
    select: questionSelect,
  });

  // Debug: for English, log what we found
  if (subject === "english") {
    // Also check how many questions exist without the filters
    const totalEnglishQs = await prisma.examQuestion.count({
      where: { examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } } },
    });
    const withStem = await prisma.examQuestion.count({
      where: { transcribedStem: { not: null }, examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } } },
    });
    const withAnswer = await prisma.examQuestion.count({
      where: { answer: { not: null }, examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } } },
    });
    const withBoth = await prisma.examQuestion.count({
      where: { transcribedStem: { not: null }, answer: { not: null }, examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } } },
    });
    console.log(`[English Quiz] Total English Qs: ${totalEnglishQs}, with stem: ${withStem}, with answer: ${withAnswer}, with both: ${withBoth}, after level/exam filter: ${allQuestions.length}`);
    if (allQuestions.length > 0) {
      const topics = new Map<string, number>();
      for (const q of allQuestions) { topics.set(q.syllabusTopic ?? "null", (topics.get(q.syllabusTopic ?? "null") ?? 0) + 1); }
      console.log(`[English Quiz] By topic:`, Object.fromEntries(topics));
    }
  }

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

  // ── ENGLISH QUIZ PATH ────────────────────────────────────────────────────
  if (subject === "english") {
    const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
    const freshQs = allQuestions.filter(q => !usedSourceIds.has(q.id));
    const usedQs = allQuestions.filter(q => usedSourceIds.has(q.id));
    const allPool = [...freshQs, ...usedQs]; // prefer fresh, fall back to used

    // Pool by syllabusTopic
    const grammarMcqPool = shuffle(allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("grammar") && q.syllabusTopic?.toLowerCase().includes("mcq") && isMcq(q.answer)));
    const vocabMcqPool = shuffle(allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("vocabulary") && q.syllabusTopic?.toLowerCase().includes("mcq") && !q.syllabusTopic?.toLowerCase().includes("cloze") && isMcq(q.answer)));

    // Vocab Cloze MCQ: group by paper (all questions from same paper go together)
    const vocabClozeAll = allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("vocabulary") && q.syllabusTopic?.toLowerCase().includes("cloze") && isMcq(q.answer));
    const vocabClozePapers = new Map<string, typeof allPool>();
    for (const q of vocabClozeAll) {
      const key = q.examPaperId;
      if (!vocabClozePapers.has(key)) vocabClozePapers.set(key, []);
      vocabClozePapers.get(key)!.push(q);
    }
    const vocabClozeSets = shuffle([...vocabClozePapers.values()]);

    // Visual Text MCQ: group by paper
    const visualTextAll = allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("visual") && q.syllabusTopic?.toLowerCase().includes("text") && isMcq(q.answer));
    const visualTextPapers = new Map<string, typeof allPool>();
    for (const q of visualTextAll) {
      const key = q.examPaperId;
      if (!visualTextPapers.has(key)) visualTextPapers.set(key, []);
      visualTextPapers.get(key)!.push(q);
    }
    const visualTextSets = shuffle([...visualTextPapers.values()]);

    // Select: 3 Grammar MCQ + 3 Vocab MCQ + either 1 Vocab Cloze set or 1 Visual Text set
    const selectedGrammar = grammarMcqPool.slice(0, 3);
    const selectedVocab = vocabMcqPool.slice(0, 3);

    // Randomly pick Vocab Cloze or Visual Text
    const useVocabCloze = vocabClozeSets.length > 0 && (visualTextSets.length === 0 || Math.random() < 0.5);
    const selectedSet = useVocabCloze
      ? (vocabClozeSets[0] ?? [])
      : (visualTextSets[0] ?? []);
    const setLabel = useVocabCloze ? "Vocabulary Cloze MCQ" : "Visual Text MCQ";

    // OEQ sections (if selected)
    const oeqSections = new Set(englishOeqSections ?? []);
    const selectedOeq: typeof allPool = [];
    const oeqLabels: string[] = [];

    // Map section keys to syllabusTopic patterns
    const oeqTopicMap: Record<string, string> = {
      "grammar-cloze": "grammar cloze",
      "editing": "editing",
      "comprehension-cloze": "comprehension cloze",
      "synthesis": "synthesis",
      "comprehension-oeq": "comprehension",
    };

    for (const [key, topicPattern] of Object.entries(oeqTopicMap)) {
      if (!oeqSections.has(key)) continue;
      const isCompOeq = key === "comprehension-oeq";
      const sectionQs = allPool.filter(q => {
        const t = (q.syllabusTopic ?? "").toLowerCase();
        if (isCompOeq) return t.includes("comprehension") && t.includes("open");
        return t.includes(topicPattern) && !t.includes("mcq");
      });

      if (key === "synthesis") {
        // Synthesis: pick 3 random individual questions
        shuffle(sectionQs);
        selectedOeq.push(...sectionQs.slice(0, 3));
        if (sectionQs.length > 0) oeqLabels.push("Synthesis");
      } else {
        // Passage-bound sections: pick all questions from one paper
        const papers = new Map<string, typeof allPool>();
        for (const q of sectionQs) {
          if (!papers.has(q.examPaperId)) papers.set(q.examPaperId, []);
          papers.get(q.examPaperId)!.push(q);
        }
        const paperSets = shuffle([...papers.values()]);
        if (paperSets.length > 0) {
          selectedOeq.push(...paperSets[0]);
          oeqLabels.push(key === "grammar-cloze" ? "Grammar Cloze" : key === "editing" ? "Editing" : key === "comprehension-cloze" ? "Comp Cloze" : "Comp OEQ");
        }
      }
    }

    const allSelected = [...selectedGrammar, ...selectedVocab, ...selectedSet, ...selectedOeq];
    if (allSelected.length === 0) {
      return NextResponse.json({ error: "Not enough English questions available" }, { status: 404 });
    }

    const totalMarks = allSelected.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
    const levelLabel = levelFilter ? `P${student!.level} ` : "";
    const titleParts = [`MCQ: Grammar + Vocab + ${setLabel}`];
    if (oeqLabels.length > 0) titleParts.push(`OEQ: ${oeqLabels.join(" + ")}`);

    const paper = await prisma.examPaper.create({
      data: {
        title: `${levelLabel}Daily Quiz – English (${titleParts.join(" | ")})`,
        subject: "English Language",
        level: levelFilter || null,
        userId,
        assignedToId: targetStudentId,
        paperType: "quiz",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        metadata: {
          quizType: "mcq",
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
            sourceQuestionId: q.id,
          })),
        },
      },
    });

    return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
  }

  // ── MATH / SCIENCE QUIZ PATH ───────────────────────────────────────────
  // Separate fresh (not yet seen) from used questions
  const freshQuestions = allQuestions.filter(q => !usedSourceIds.has(q.id));
  const usedQuestions  = allQuestions.filter(q =>  usedSourceIds.has(q.id));

  const { mcqPool: mcqFresh, oeqPool: oeqFresh } = buildPools(freshQuestions);
  const { mcqPool: mcqUsed,  oeqPool: oeqUsed  } = buildPools(usedQuestions);
  shuffle(mcqFresh); shuffle(oeqFresh);
  shuffle(mcqUsed);  shuffle(oeqUsed);

  const mcqTarget = quizType === "mcq" ? 20 : 10;
  const oeqTarget = 5;

  // Top up from level-1 if current level doesn't have enough fresh questions
  let mcqFreshPool = mcqFresh;
  let oeqFreshPool = oeqFresh;
  let mcqUsedPool  = mcqUsed;
  let oeqUsedPool  = oeqUsed;

  if (student?.level && student.level > 1 && (mcqFreshPool.length < mcqTarget || oeqFreshPool.length < oeqTarget)) {
    const prevLevelFilter = `Primary ${student.level - 1}`;
    const prevLevelQuestions = await prisma.examQuestion.findMany({
      where: questionWhere(prevLevelFilter, null),
      select: questionSelect,
    });
    const prevFresh = prevLevelQuestions.filter(q => !usedSourceIds.has(q.id));
    const prevUsed  = prevLevelQuestions.filter(q =>  usedSourceIds.has(q.id));
    const { mcqPool: mcqPF, oeqPool: oeqPF } = buildPools(prevFresh);
    const { mcqPool: mcqPU, oeqPool: oeqPU } = buildPools(prevUsed);
    shuffle(mcqPF); shuffle(oeqPF);
    shuffle(mcqPU); shuffle(oeqPU);
    mcqFreshPool = [...mcqFreshPool, ...mcqPF];
    oeqFreshPool = [...oeqFreshPool, ...oeqPF];
    mcqUsedPool  = [...mcqUsedPool,  ...mcqPU];
    oeqUsedPool  = [...oeqUsedPool,  ...oeqPU];
  }

  // Use fresh questions first; fall back to previously-seen ones if pool is exhausted
  const mcqPool = mcqFreshPool.length >= mcqTarget
    ? mcqFreshPool
    : [...mcqFreshPool, ...mcqUsedPool];
  const oeqPool = oeqFreshPool.length >= oeqTarget
    ? oeqFreshPool
    : [...oeqFreshPool, ...oeqUsedPool];

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
