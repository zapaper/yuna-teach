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
  const { userId, studentId, quizType, subject, englishSections } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
    subject?: "math" | "science" | "english";
    englishSections?: string[]; // e.g. ["vocab-cloze", "editing"]
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
  // For English: don't filter by examType (English papers don't follow WA1/WA2 schedule)
  const allQuestions = await prisma.examQuestion.findMany({
    where: questionWhere(levelFilter ?? null, subject === "english" ? null : allowedExamTypes),
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
    const withBothNoFilter = await prisma.examQuestion.count({
      where: { transcribedStem: { not: null }, answer: { not: null }, examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } } },
    });
    console.log(`[English Quiz] Total: ${totalEnglishQs}, stem: ${withStem}, answer: ${withAnswer}, both: ${withBothNoFilter}, level="${levelFilter}", examType=${subject === "english" ? "none" : JSON.stringify(allowedExamTypes)}, after filter: ${allQuestions.length}`);
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

    // Pool by syllabusTopic — match both old ("Grammar") and new ("Grammar MCQ") naming
    const grammarMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "grammar" || t === "grammar mcq") && isMcq(q.answer);
    }));
    const vocabMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "vocabulary" || t === "vocabulary mcq") && isMcq(q.answer);
    }));

    // Vocab Cloze MCQ: group by paper (all questions from same paper go together)
    const vocabClozeAll = allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t.includes("vocabulary") && t.includes("cloze")) && isMcq(q.answer);
    });
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

    // Select: 3 Grammar MCQ + 3 Vocab MCQ + selected sections
    console.log(`[English Quiz] Pools: grammar=${grammarMcqPool.length}, vocab=${vocabMcqPool.length}, vocabCloze=${vocabClozeSets.length} sets, visualText=${visualTextSets.length} sets`);
    const selectedGrammar = grammarMcqPool.slice(0, 3);
    const selectedVocab = vocabMcqPool.slice(0, 3);
    console.log(`[English Quiz] Selected: grammar=${selectedGrammar.length}, vocab=${selectedVocab.length}`);

    // Select additional sections based on user choices (checkboxes)
    const selectedSections = new Set(englishSections ?? ["vocab-cloze"]);
    const selectedExtra: typeof allPool = [];
    const sectionLabels: Record<string, string> = {
      "vocab-cloze": "Vocab Cloze", "visual-text": "Visual Text",
      "grammar-cloze": "Grammar Cloze", "editing": "Editing",
      "comprehension-cloze": "Comp Cloze", "synthesis": "Synthesis",
      "comprehension-oeq": "Comp OEQ",
    };
    const activeLabels: string[] = [];

    const topicMatchers: Record<string, (t: string) => boolean> = {
      "grammar-cloze": t => t.includes("grammar") && t.includes("cloze") && !t.includes("mcq"),
      "editing": t => t.includes("editing"),
      "comprehension-cloze": t => t.includes("comprehension") && t.includes("cloze"),
      "synthesis": t => t.includes("synthesis"),
      "comprehension-oeq": t => t.includes("comprehension") && t.includes("open"),
    };

    for (const section of selectedSections) {
      if (section === "vocab-cloze" && vocabClozeSets.length > 0) {
        selectedExtra.push(...vocabClozeSets[0]);
        activeLabels.push("Vocab Cloze");
      } else if (section === "visual-text" && visualTextSets.length > 0) {
        selectedExtra.push(...visualTextSets[0]);
        activeLabels.push("Visual Text");
      } else if (section === "synthesis") {
        const synthQs = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("synthesis"));
        shuffle(synthQs);
        selectedExtra.push(...synthQs.slice(0, 3));
        if (synthQs.length > 0) activeLabels.push("Synthesis");
      } else {
        const matcher = topicMatchers[section];
        if (matcher) {
          const sectionQs = allPool.filter(q => matcher((q.syllabusTopic ?? "").toLowerCase()));
          const papers = new Map<string, typeof allPool>();
          for (const q of sectionQs) {
            if (!papers.has(q.examPaperId)) papers.set(q.examPaperId, []);
            papers.get(q.examPaperId)!.push(q);
          }
          const paperSets = shuffle([...papers.values()]);
          if (paperSets.length > 0) {
            selectedExtra.push(...paperSets[0]);
            activeLabels.push(sectionLabels[section] ?? section);
          }
        }
      }
    }

    const allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];
    if (allSelected.length === 0) {
      return NextResponse.json({ error: "Not enough English questions available" }, { status: 404 });
    }

    // Build section metadata for quiz display
    const sections: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> = [];
    let idx = 0;
    if (selectedGrammar.length > 0 || selectedVocab.length > 0) {
      sections.push({ label: "Section A: Grammar and Vocab MCQ", startIndex: idx, endIndex: idx + selectedGrammar.length + selectedVocab.length - 1 });
      idx += selectedGrammar.length + selectedVocab.length;
    }

    // For each extra section, get the passage if it's passage-bound
    let sectionLetter = "B";
    for (const section of selectedSections) {
      const sectionQs = allSelected.slice(idx).filter((_, i) => {
        const qIdx = idx + i;
        return qIdx >= idx && qIdx < idx + selectedExtra.filter((_, j) => {
          // This is hacky — need a better way to track which extra questions belong to which section
          return true;
        }).length;
      });

      // Find passage OCR from the source question's transcribedSubparts
      let passage: string | undefined;
      const firstExtraQ = selectedExtra.find(q => {
        const t = (q.syllabusTopic ?? "").toLowerCase();
        if (section === "vocab-cloze") return t.includes("vocabulary") && t.includes("cloze");
        if (section === "visual-text") return t.includes("visual") && t.includes("text");
        if (section === "grammar-cloze") return t.includes("grammar") && t.includes("cloze") && !t.includes("mcq");
        if (section === "editing") return t.includes("editing");
        if (section === "comprehension-cloze") return t.includes("comprehension") && t.includes("cloze");
        if (section === "comprehension-oeq") return t.includes("comprehension") && t.includes("open");
        return false;
      });

      if (firstExtraQ) {
        // Try 1: Get passage from transcribedSubparts sentinel (_passage)
        const subs = firstExtraQ.transcribedSubparts as Array<{ label: string; text: string }> | null;
        const passageSub = subs?.find(s => s.label === "_passage");
        if (passageSub) {
          passage = passageSub.text;
        } else {
          // Try 2: Get passage from the source paper's sectionOcrTexts metadata
          const sourcePaper = await prisma.examPaper.findUnique({
            where: { id: firstExtraQ.examPaperId },
            select: { metadata: true },
          });
          const meta = sourcePaper?.metadata as { sectionOcrTexts?: Record<string, { ocrText: string }> } | null;
          if (meta?.sectionOcrTexts) {
            // Map section keys to exact sectionOcrTexts names
            const sectionOcrNames: Record<string, string[]> = {
              "vocab-cloze": ["Vocabulary Cloze MCQ", "Vocabulary Cloze", "Vocab Cloze MCQ"],
              "visual-text": ["Visual Text Comprehension MCQ", "Visual Text MCQ", "Visual Text Comprehension"],
              "grammar-cloze": ["Grammar Cloze"],
              "editing": ["Editing", "Editing (Spelling & Grammar)"],
              "comprehension-cloze": ["Comprehension Cloze"],
              "synthesis": ["Synthesis & Transformation", "Synthesis"],
              "comprehension-oeq": ["Comprehension OEQ", "Comprehension Open Ended", "Comprehension (Open-ended)"],
            };
            const possibleNames = sectionOcrNames[section] ?? [];
            for (const name of possibleNames) {
              if (meta.sectionOcrTexts[name]) {
                passage = meta.sectionOcrTexts[name].ocrText;
                break;
              }
            }
          }
        }
        console.log(`[English Quiz] ${section}: passage ${passage ? `found (${passage.length} chars)` : "NOT found"}`);
      }

      const secLabel = sectionLabels[section] ?? section;
      const count = selectedExtra.length; // simplified — all extras are one section for now
      sections.push({
        label: `Section ${sectionLetter}: ${secLabel}`,
        startIndex: idx,
        endIndex: idx + count - 1,
        ...(passage ? { passage } : {}),
      });
      idx += count;
      sectionLetter = String.fromCharCode(sectionLetter.charCodeAt(0) + 1);
      break; // Only one extra section supported for now
    }

    const totalMarks = allSelected.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
    const levelLabel = levelFilter ? `P${student!.level} ` : "";
    const extraLabel = activeLabels.length > 0 ? ` + ${activeLabels.join(" + ")}` : "";

    const paper = await prisma.examPaper.create({
      data: {
        title: `${levelLabel}Daily Quiz – English (Grammar + Vocab MCQ${extraLabel})`,
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
          englishSections: sections,
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
