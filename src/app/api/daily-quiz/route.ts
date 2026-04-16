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
  const { userId, studentId, quizType, subject, englishSections, sourcePaperId, scheduledFor, focused } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
    subject?: "math" | "science" | "english";
    englishSections?: string[];
    sourcePaperId?: string; // admin: generate test quiz from specific paper
    scheduledFor?: string; // ISO date; when the quiz should appear on the student's dashboard
    focused?: boolean; // when true + english + single section, take 2x questions for that section
  };
  const scheduledForDate = scheduledFor ? new Date(scheduledFor) : undefined;
  const isFocusedEnglish = !!focused && subject === "english";

  // ── Admin: generate test quiz from a specific paper ──
  if (sourcePaperId) {
    const paper = await prisma.examPaper.findUnique({
      where: { id: sourcePaperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

    const isEnglish = (paper.subject ?? "").toLowerCase().includes("english");
    const allQs = paper.questions.filter(q => q.answer);
    if (allQs.length === 0) return NextResponse.json({ error: "No questions with answers" }, { status: 404 });

    const mcqQs = allQs.filter(q => {
      const n = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      return n === "1" || n === "2" || n === "3" || n === "4";
    });
    const oeqQs = allQs.filter(q => {
      const n = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      return !(n === "1" || n === "2" || n === "3" || n === "4");
    });
    const totalMarks = allQs.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);

    // Build English sections if applicable
    let englishSectionsMeta: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | undefined;
    if (isEnglish) {
      const sectionMap = new Map<string, typeof allQs>();
      for (const q of allQs) {
        const topic = q.syllabusTopic ?? "Other";
        if (!sectionMap.has(topic)) sectionMap.set(topic, []);
        sectionMap.get(topic)!.push(q);
      }
      // Sort sections in standard English paper order
      const sectionOrder = ["Grammar MCQ", "Vocabulary MCQ", "Vocabulary Cloze MCQ", "Visual Text Comprehension MCQ", "Grammar Cloze", "Editing (Spelling & Grammar)", "Comprehension Cloze", "Synthesis / Transformation", "Comprehension Open Ended"];
      const sortedTopics = [...sectionMap.keys()].sort((a, b) => {
        const ai = sectionOrder.indexOf(a);
        const bi = sectionOrder.indexOf(b);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      // Rebuild allQs in section order so question indices match section metadata
      const reorderedQs: typeof allQs = [];
      for (const topic of sortedTopics) reorderedQs.push(...sectionMap.get(topic)!);
      allQs.length = 0;
      allQs.push(...reorderedQs);

      englishSectionsMeta = [];
      let idx = 0;
      const ocrTexts = (paper.metadata as Record<string, unknown>)?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string; passagePageIndices?: number[] }> | undefined;
      for (const [topic, qs] of sectionMap) {
        const topicLower = topic.toLowerCase();
        // Don't set passage for standalone MCQ sections (Grammar MCQ, Vocabulary MCQ)
        const isStandaloneMcq = (topicLower.includes("grammar") && !topicLower.includes("cloze") && !topicLower.includes("editing"))
          || (topicLower.includes("vocab") && !topicLower.includes("cloze"));
        const isVisualText = topicLower.includes("visual") && topicLower.includes("text");
        const isCompOeq = topicLower.includes("comprehension") && !topicLower.includes("cloze");
        // Visual text: use [VISUAL_PAGES:paperId:pageIndices] format to load scanned pages
        const sectionOcr = ocrTexts?.[topic];
        let passage: string | undefined;
        if (isStandaloneMcq) {
          passage = undefined;
        } else if (isVisualText && sectionOcr?.passagePageIndices?.length) {
          passage = `[VISUAL_PAGES:${paper.id}:${sectionOcr.passagePageIndices.join(",")}]`;
        } else if (isCompOeq) {
          // Comp OEQ: prefer passageOcrText (reading passage), NOT ocrText (question text)
          passage = sectionOcr?.passageOcrText ?? sectionOcr?.ocrText;
        } else {
          passage = sectionOcr?.ocrText ?? sectionOcr?.passageOcrText;
        }
        englishSectionsMeta.push({
          label: topic,
          startIndex: idx,
          endIndex: idx + qs.length - 1,
          ...(passage ? { passage } : {}),
        });
        idx += qs.length;
      }
    }

    const testQuiz = await prisma.examPaper.create({
      data: {
        title: `Test Quiz — ${paper.title}`,
        subject: paper.subject,
        level: paper.level,
        userId,
        assignedToId: userId,
        ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
        paperType: "quiz",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        metadata: {
          quizType: oeqQs.length > 0 ? "mcq-oeq" : "mcq",
          ...(englishSectionsMeta ? { englishSections: englishSectionsMeta } : {}),
          sourceLabels: Object.fromEntries(allQs.map((q, i) => [String(i + 1), [paper.year, paper.examType, paper.school].filter(Boolean).join(" ") || null])),
        },
        questions: {
          create: allQs.map((q, i) => ({
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

    return NextResponse.json({ id: testQuiz.id, questionCount: allQs.length });
  }

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
    // English: don't require transcribedStem (passage-bound sections don't have stems)
    ...(subject !== "english" ? { transcribedStem: { not: null as null } } : {}),
    answer: { not: null as null },
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subjectFilter, mode: "insensitive" as const },
      ...(lf ? { level: lf } : {}),
      ...(examTypeFilter ? { examType: { in: examTypeFilter } } : {}),
    },
  });

  // Light select for pool building (excludes large blob fields)
  const questionSelectLight = {
    id: true,
    questionNum: true,
    examPaperId: true,
    answer: true,
    marksAvailable: true,
    syllabusTopic: true,
    pageIndex: true,
    transcribedStem: true,
    transcribedSubparts: true,
    // diagramImageData needed for mergeOeqGroup (Math/Science only)
    ...(subject !== "english" ? { diagramImageData: true } : {}),
    diagramBounds: true,
    examPaper: {
      select: { id: true, year: true, examType: true, school: true, pageCount: true },
    },
  };

  // Run both queries in parallel for speed
  const [previousQuizQuestions, allQuestions] = await Promise.all([
    // Get source question IDs already used in this student's previous quizzes
    prisma.examQuestion.findMany({
      where: {
        sourceQuestionId: { not: null },
        examPaper: { assignedToId: targetStudentId, paperType: "quiz" },
      },
      select: { sourceQuestionId: true },
    }),
    // Find all clean-extracted questions from master papers (matching level + semester)
    // Light query first (no blobs) — full data loaded later for selected questions only
    prisma.examQuestion.findMany({
      where: questionWhere(levelFilter ?? null, subject === "english" ? null : allowedExamTypes),
      select: questionSelectLight,
    }),
  ]);
  const usedSourceIds = new Set(previousQuizQuestions.map(q => q.sourceQuestionId!));

  type Q = typeof allQuestions[number];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type FullQ = Q & { imageData: string | null; answerImageData: string | null; transcribedOptions: any; transcribedOptionImages: any; diagramImageData: string | null };

  // Hydrate lightweight questions with large blob fields — only for the final selected set
  async function hydrateBlobs(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.examQuestion.findMany({
      where: { id: { in: ids } },
      select: { id: true, imageData: true, answerImageData: true, transcribedOptions: true, transcribedOptionImages: true, diagramImageData: true },
    });
    return new Map(rows.map(r => [r.id, r]));
  }

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

    // Pool by syllabusTopic — match various naming patterns including "Section X: Grammar MCQ"
    // MCQ pools require a stem (or image) to display — exclude blank questions
    const hasStemOrImage = (q: Q) => !!(q.transcribedStem?.trim());
    const grammarMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "grammar" || t === "grammar mcq" || (t.includes("grammar") && !t.includes("cloze"))) && isMcq(q.answer) && hasStemOrImage(q);
    }));
    const vocabMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "vocabulary" || t === "vocabulary mcq" || (t.includes("vocab") && !t.includes("cloze"))) && isMcq(q.answer) && hasStemOrImage(q);
    }));

    // Vocab Cloze MCQ: group by paper, then split each paper's set into 5-question
    // sub-passages. A single source paper often has TWO 5-question vocab cloze passages
    // (e.g. Q11-Q15 + Q16-Q20). Treating them as one 10-question set means the rendered
    // quiz mixes both passages without showing either one as context. Split by
    // question-number sequence so each sub-set maps to one passage.
    const vocabClozeAll = allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t.includes("vocabulary") && t.includes("cloze")) && isMcq(q.answer);
    });
    const vocabClozePaperGroups = new Map<string, typeof allPool>();
    for (const q of vocabClozeAll) {
      const key = q.examPaperId;
      if (!vocabClozePaperGroups.has(key)) vocabClozePaperGroups.set(key, []);
      vocabClozePaperGroups.get(key)!.push(q);
    }
    const vocabClozePapers = new Map<string, typeof allPool>();
    let vocabClozeSplitIdx = 0;
    for (const [paperId, qs] of vocabClozePaperGroups.entries()) {
      const sorted = [...qs].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
      const CHUNK = 5;
      if (sorted.length <= CHUNK) {
        vocabClozePapers.set(paperId, sorted);
        continue;
      }
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const chunk = sorted.slice(i, i + CHUNK);
        if (chunk.length > 0) {
          vocabClozePapers.set(`${paperId}#${vocabClozeSplitIdx++}`, chunk);
        }
      }
    }
    // Sort sets: all-fresh first, then partially fresh, then all-used
    const sortByFreshness = (sets: (typeof allPool)[]) => {
      return sets.sort((a, b) => {
        const aFresh = a.filter(q => !usedSourceIds.has(q.id)).length;
        const bFresh = b.filter(q => !usedSourceIds.has(q.id)).length;
        const aRatio = a.length > 0 ? aFresh / a.length : 0;
        const bRatio = b.length > 0 ? bFresh / b.length : 0;
        if (aRatio !== bRatio) return bRatio - aRatio; // more fresh first
        return Math.random() - 0.5; // shuffle within same freshness
      });
    };
    const vocabClozeSets = sortByFreshness([...vocabClozePapers.values()]);

    // Visual Text MCQ: group by paper
    const visualTextAll = allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("visual") && q.syllabusTopic?.toLowerCase().includes("text") && isMcq(q.answer));
    const visualTextPapers = new Map<string, typeof allPool>();
    for (const q of visualTextAll) {
      const key = q.examPaperId;
      if (!visualTextPapers.has(key)) visualTextPapers.set(key, []);
      visualTextPapers.get(key)!.push(q);
    }
    const visualTextSets = sortByFreshness([...visualTextPapers.values()]);

    // Select Grammar/Vocab MCQ based on user choices
    const selectedSections = new Set(englishSections ?? ["grammar-mcq", "vocab-mcq", "vocab-cloze"]);
    // Debug: show why grammar/vocab pools might be empty
    if (grammarMcqPool.length === 0 || vocabMcqPool.length === 0) {
      const grammarAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("grammar") && !(q.syllabusTopic ?? "").toLowerCase().includes("cloze"));
      const vocabAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("vocab") && !(q.syllabusTopic ?? "").toLowerCase().includes("cloze"));
      console.log(`[English Quiz] Grammar candidates: ${grammarAll.length} (MCQ: ${grammarAll.filter(q => isMcq(q.answer)).length}), sample answers: [${grammarAll.slice(0, 3).map(q => q.answer).join(", ")}]`);
      console.log(`[English Quiz] Vocab candidates: ${vocabAll.length} (MCQ: ${vocabAll.filter(q => isMcq(q.answer)).length}), sample answers: [${vocabAll.slice(0, 3).map(q => q.answer).join(", ")}]`);
    }
    console.log(`[English Quiz] Pools: grammar=${grammarMcqPool.length}, vocab=${vocabMcqPool.length}, vocabCloze=${vocabClozeSets.length} sets, visualText=${visualTextSets.length} sets`);
    const mcqTake = isFocusedEnglish ? 10 : 5;
    const selectedGrammar = selectedSections.has("grammar-mcq") ? grammarMcqPool.slice(0, mcqTake) : [];
    const selectedVocab = selectedSections.has("vocab-mcq") ? vocabMcqPool.slice(0, mcqTake) : [];
    console.log(`[English Quiz] Selected: grammar=${selectedGrammar.length}, vocab=${selectedVocab.length}`);
    const selectedExtra: typeof allPool = [];
    const sectionLabels: Record<string, string> = {
      "vocab-cloze": "Vocab Cloze", "visual-text": "Visual Text",
      "grammar-cloze": "Grammar Cloze", "editing": "Editing",
      "comprehension-cloze": "Comprehension Cloze", "synthesis": "Synthesis",
      "comprehension-oeq": "Comprehension OEQ",
    };
    const activeLabels: string[] = [];
    // Track per-section question groups for section metadata
    const extraSectionGroups: Array<{ key: string; label: string; questions: typeof allPool }> = [];

    const topicMatchers: Record<string, (t: string) => boolean> = {
      "grammar-cloze": t => t.includes("grammar") && t.includes("cloze") && !t.includes("mcq"),
      "editing": t => t.includes("editing"),
      "comprehension-cloze": t => t.includes("comprehension") && t.includes("cloze"),
      "synthesis": t => t.includes("synthesis"),
      "comprehension-oeq": t => t.includes("comprehension") && (t.includes("open") || t.includes("oeq")),
    };

    // Fixed order: MCQ sections first (Vocab Cloze, Visual Text), then OEQ sections
    const sectionOrder = ["vocab-cloze", "visual-text", "grammar-cloze", "editing", "comprehension-cloze", "synthesis", "comprehension-oeq"];
    const orderedSections = sectionOrder.filter(s => selectedSections.has(s));

    // Sections that can be doubled by rendering TWO independent passages
    // (distinct paper sets) back-to-back in focused mode. Vocab / grammar /
    // comprehension cloze + editing + visual text all have "one passage + N
    // questions" structure, so each doubled section = 2 passages.
    const DOUBLABLE_PASSAGE_SECTIONS = new Set(["vocab-cloze", "grammar-cloze", "comprehension-cloze", "editing"]);

    const pushSectionGroup = (section: string, qs: typeof allPool, occurrence: number, total: number) => {
      if (qs.length === 0) return;
      // Sort by original question number so passage markers align
      const sorted = [...qs].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
      const baseLabel = sectionLabels[section] ?? section;
      const label = total > 1 ? `${baseLabel} (${occurrence}/${total})` : baseLabel;
      selectedExtra.push(...sorted);
      activeLabels.push(label);
      extraSectionGroups.push({ key: section, label, questions: sorted });
    };

    for (const section of orderedSections) {
      // Visual text: 1 passage normally, 2 distinct passages in focused mode
      if (section === "visual-text") {
        const take = isFocusedEnglish && visualTextSets.length >= 2 ? 2 : Math.min(1, visualTextSets.length);
        for (let i = 0; i < take; i++) pushSectionGroup(section, visualTextSets[i], i + 1, take);
        continue;
      }
      // Vocab cloze: 2 distinct passage sets for focused practice
      if (section === "vocab-cloze") {
        const take = isFocusedEnglish && vocabClozeSets.length >= 2 ? 2 : Math.min(1, vocabClozeSets.length);
        for (let i = 0; i < take; i++) pushSectionGroup(section, vocabClozeSets[i], i + 1, take);
        continue;
      }
      // Synthesis: flat 10 questions (or 5 for non-focused), not passage-bound
      if (section === "synthesis") {
        const synthAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("synthesis"));
        const synthFresh = shuffle(synthAll.filter(q => !usedSourceIds.has(q.id)));
        const synthUsed = shuffle(synthAll.filter(q => usedSourceIds.has(q.id)));
        pushSectionGroup(section, [...synthFresh, ...synthUsed].slice(0, isFocusedEnglish ? 10 : 5), 1, 1);
        continue;
      }
      // grammar-cloze, editing, comprehension-cloze, comprehension-oeq — passage-bound.
      const matcher = topicMatchers[section];
      if (!matcher) continue;
      const matchedQs = allPool.filter(q => matcher((q.syllabusTopic ?? "").toLowerCase()));
      const papersMap = new Map<string, typeof allPool>();
      for (const q of matchedQs) {
        if (!papersMap.has(q.examPaperId)) papersMap.set(q.examPaperId, []);
        papersMap.get(q.examPaperId)!.push(q);
      }
      const paperSets = sortByFreshness([...papersMap.values()]);
      if (paperSets.length === 0) continue;
      if (isFocusedEnglish && DOUBLABLE_PASSAGE_SECTIONS.has(section) && paperSets.length >= 2) {
        pushSectionGroup(section, paperSets[0], 1, 2);
        pushSectionGroup(section, paperSets[1], 2, 2);
      } else {
        // editing, comprehension-oeq, or only one paper available — single passage
        pushSectionGroup(section, paperSets[0], 1, 1);
      }
    }

    let allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];
    if (allSelected.length === 0) {
      return NextResponse.json({ error: "Not enough English questions available" }, { status: 404 });
    }

    // Pre-fetch all source paper metadata in one batch
    const sourcePaperIds = [...new Set(selectedExtra.map(q => q.examPaperId))];
    const sourcePapers = sourcePaperIds.length > 0
      ? await prisma.examPaper.findMany({ where: { id: { in: sourcePaperIds } }, select: { id: true, metadata: true } })
      : [];
    const sourcePaperMap = new Map(sourcePapers.map(p => [p.id, p.metadata as { sectionOcrTexts?: Record<string, { ocrText: string }> } | null]));

    // Build section metadata for quiz display
    const sections: Array<{ label: string; startIndex: number; endIndex: number; passage?: string; sourceExamId?: string }> = [];
    let idx = 0;
    if (selectedGrammar.length > 0 || selectedVocab.length > 0) {
      sections.push({ label: "Section A: Grammar and Vocab MCQ", startIndex: idx, endIndex: idx + selectedGrammar.length + selectedVocab.length - 1 });
      idx += selectedGrammar.length + selectedVocab.length;
    }

    // For each extra section group, build section metadata with passage
    let sectionLetter = (selectedGrammar.length > 0 || selectedVocab.length > 0) ? "B" : "A";
    const sectionOcrNames: Record<string, string[]> = {
      "vocab-cloze": ["Vocabulary Cloze MCQ", "Vocabulary Cloze", "Vocab Cloze MCQ"],
      "visual-text": ["Visual Text Comprehension MCQ", "Visual Text MCQ", "Visual Text Comprehension"],
      "grammar-cloze": ["Grammar Cloze"],
      "editing": ["Editing", "Editing (Spelling & Grammar)", "Editing for Spelling and Grammar", "Editing (Spelling and Grammar)"],
      "comprehension-cloze": ["Comprehension Cloze"],
      "synthesis": ["Synthesis & Transformation", "Synthesis"],
      "comprehension-oeq": ["Comprehension OEQ", "Comprehension Open Ended", "Comprehension (Open-ended)"],
    };

    for (const group of extraSectionGroups) {
      let passage: string | undefined;
      const firstQ = group.questions[0];

      if (firstQ) {
        // Try 1: transcribedSubparts sentinel (skip for Comp OEQ — _passage has question OCR, not reading passage)
        if (group.key !== "comprehension-oeq") {
          const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }> | null;
          const passageSub = subs?.find(s => s.label === "_passage");
          if (passageSub) { passage = passageSub.text; }
        }

        // Try 2: source paper's sectionOcrTexts (pre-fetched batch)
        // Skip for sections that don't use inline passage markers
        const skipOcrLookup = group.key === "visual-text" || group.key === "synthesis";
        // Comprehension OEQ: load the reading passage (passageOcrText), not the question OCR
        if (!passage && group.key === "comprehension-oeq") {
          const meta = sourcePaperMap.get(firstQ.examPaperId);
          if (meta?.sectionOcrTexts) {
            const ocrKeys = Object.keys(meta.sectionOcrTexts);
            console.log(`[English Quiz] Comp OEQ: sectionOcrTexts keys = [${ocrKeys.join(", ")}]`);
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              const sl = secName.toLowerCase();
              if (sl.includes("comprehension") && (sl.includes("open") || sl.includes("oeq"))) {
                const fullData = secData as Record<string, unknown>;
                console.log(`[English Quiz] Comp OEQ: matched "${secName}", keys = [${Object.keys(fullData).join(", ")}]`);
                const passageText = fullData.passageOcrText as string | undefined;
                if (passageText) {
                  passage = passageText;
                  console.log(`[English Quiz] Comp OEQ: loaded reading passage (${passageText.length} chars)`);
                } else {
                  console.log(`[English Quiz] Comp OEQ: no passageOcrText in "${secName}"`);
                }
                break;
              }
            }
          } else {
            console.log(`[English Quiz] Comp OEQ: source paper ${firstQ.examPaperId} has no sectionOcrTexts`);
          }
          // Fallback: try loading from question's transcribedSubparts (_passageText)
          if (!passage && firstQ.transcribedSubparts) {
            const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }>;
            const passageSub = subs.find(s => s.label === "_passageText");
            if (passageSub) {
              passage = passageSub.text;
              console.log(`[English Quiz] Comp OEQ: loaded passage from _passageText subpart (${passage.length} chars)`);
            }
          }
          if (!passage) console.log(`[English Quiz] Comp OEQ: no reading passage found`);
        }
        if (!passage && !skipOcrLookup && group.key !== "comprehension-oeq") {
          const meta = sourcePaperMap.get(firstQ.examPaperId);
          if (meta?.sectionOcrTexts) {
            // Try exact name match first
            for (const name of (sectionOcrNames[group.key] ?? [])) {
              if (meta.sectionOcrTexts[name]) { passage = meta.sectionOcrTexts[name].ocrText; break; }
            }
            // Fuzzy fallback: match by key words
            if (!passage) {
              const keyWords: Record<string, string[]> = {
                "grammar-cloze": ["grammar", "cloze"],
                "editing": ["editing"],
                "comprehension-cloze": ["comprehension", "cloze"],
                "vocab-cloze": ["vocab", "cloze"],
                "synthesis": ["synthesis"],
                "comprehension-oeq": ["comprehension", "open"],
              };
              const words = keyWords[group.key] ?? [];
              if (words.length > 0) {
                for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
                  const nameLower = secName.toLowerCase();
                  if (words.every(w => nameLower.includes(w))) {
                    passage = secData.ocrText;
                    console.log(`[English Quiz] Fuzzy matched "${secName}" for ${group.key}`);
                    break;
                  }
                }
              }
            }
          }
        }

        // Try 3: Visual Text — compute passage page indices from source paper
        if (group.key === "visual-text" && !passage) {
          const sourcePaperId = firstQ.examPaperId;
          console.log(`[English Quiz] Visual Text: source paper ${sourcePaperId}`);

          // First try sectionOcrTexts.passagePageIndices
          const meta = sourcePaperMap.get(sourcePaperId);
          if (meta?.sectionOcrTexts) {
            console.log(`[English Quiz] Visual Text: sectionOcrTexts keys = [${Object.keys(meta.sectionOcrTexts).join(", ")}]`);
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              if (secName.toLowerCase().includes("visual") && secName.toLowerCase().includes("text")) {
                const pageIndices = (secData as { passagePageIndices?: number[] }).passagePageIndices;
                console.log(`[English Quiz] Visual Text: found "${secName}", passagePageIndices = ${JSON.stringify(pageIndices)}`);
                if (pageIndices?.length) {
                  passage = `[VISUAL_PAGES:${sourcePaperId}:${pageIndices.join(",")}]`;
                }
                break;
              }
            }
          } else {
            console.log(`[English Quiz] Visual Text: no sectionOcrTexts in source paper metadata`);
          }

          // Fallback: compute visual text context pages from ALL source paper questions
          if (!passage) {
            try {
              const sourcePaperQuestions = await prisma.examQuestion.findMany({
                where: { examPaperId: sourcePaperId },
                select: { pageIndex: true, syllabusTopic: true, questionNum: true },
                orderBy: { orderIndex: "asc" },
              });
              console.log(`[English Quiz] Visual Text: source paper has ${sourcePaperQuestions.length} questions`);
              const vtQs = sourcePaperQuestions.filter(q =>
                (q.syllabusTopic ?? "").toLowerCase().includes("visual") && (q.syllabusTopic ?? "").toLowerCase().includes("text")
              );
              const nonVtQs = sourcePaperQuestions.filter(q =>
                !((q.syllabusTopic ?? "").toLowerCase().includes("visual") && (q.syllabusTopic ?? "").toLowerCase().includes("text"))
              );
              console.log(`[English Quiz] Visual Text: ${vtQs.length} VT questions on pages [${[...new Set(vtQs.map(q => q.pageIndex))]}], ${nonVtQs.length} non-VT on pages [${[...new Set(nonVtQs.map(q => q.pageIndex))]}]`);

              if (vtQs.length > 0 && nonVtQs.length > 0) {
                const vtPages = new Set(vtQs.map(q => q.pageIndex));
                const nonVtPages = new Set(nonVtQs.map(q => q.pageIndex));
                const lastNonVtPage = Math.max(...nonVtPages);
                const firstVtPage = Math.min(...vtPages);
                const totalPages = (firstQ as any).examPaper?.pageCount ?? 0;
                console.log(`[English Quiz] Visual Text: lastNonVtPage=${lastNonVtPage}, firstVtPage=${firstVtPage}, totalPages=${totalPages}`);
                const contextPages: number[] = [];
                for (let p = lastNonVtPage + 1; p < firstVtPage && p < totalPages; p++) {
                  contextPages.push(p);
                }
                // If no context pages found, use the VT question pages themselves
                const pagesToUse = contextPages.length > 0 ? contextPages : [...vtPages].sort((a, b) => a - b);
                passage = `[VISUAL_PAGES:${sourcePaperId}:${pagesToUse.join(",")}]`;
                console.log(`[English Quiz] Visual Text: using pages [${pagesToUse}] (${contextPages.length > 0 ? "context" : "question pages"})`);
              } else if (vtQs.length > 0) {
                // No non-VT questions, use VT question pages
                const vtPages = [...new Set(vtQs.map(q => q.pageIndex))].sort((a, b) => a - b);
                passage = `[VISUAL_PAGES:${sourcePaperId}:${vtPages.join(",")}]`;
                console.log(`[English Quiz] Visual Text: using VT question pages [${vtPages}]`);
              }
            } catch (err) {
              console.warn(`[English Quiz] Visual Text: failed to compute context pages:`, err);
            }
          }

          if (!passage) {
            console.warn(`[English Quiz] Visual Text: ALL methods failed, using VISUAL_TEXT_SOURCE fallback`);
            passage = `[VISUAL_TEXT_SOURCE:${sourcePaperId}]`;
          }
        }
      }

      // For vocab cloze sets that came from a paper with multiple passages, narrow
      // the passage text to just the paragraph(s) containing this chunk's question
      // numbers. The full sectionOcrText holds both passages, so without this trim
      // both groups would render the same combined passage.
      if (passage && !passage.startsWith("[") && group.key === "vocab-cloze") {
        const targetNums = new Set(group.questions.map(q => parseInt(q.questionNum)).filter(n => !isNaN(n)));
        if (targetNums.size > 0) {
          const allMk: { num: number; index: number; end: number }[] = [];
          const re = /\*\*\((\d+)\)[^*]*\*\*/g;
          let mk;
          while ((mk = re.exec(passage)) !== null) {
            allMk.push({ num: parseInt(mk[1]), index: mk.index, end: mk.index + mk[0].length });
          }
          const inChunk = allMk.filter(m => targetNums.has(m.num));
          if (inChunk.length > 0 && inChunk.length < allMk.length) {
            // Walk to the nearest paragraph boundary on either side of the chunk's markers
            const first = inChunk[0].index;
            const last = inChunk[inChunk.length - 1].end;
            let start = passage.lastIndexOf("\n\n", first);
            start = start < 0 ? 0 : start + 2;
            let endNl = passage.indexOf("\n\n", last);
            if (endNl < 0) endNl = passage.length;
            passage = passage.slice(start, endNl).trim();
            console.log(`[English Quiz] ${group.label}: narrowed passage to paragraph(s) containing Q${[...targetNums].sort((a,b)=>a-b).join(",")}`);
          }
        }
      }

      // Clean passage: keep only the first N markers, truncate after the last one.
      // Also handle the inverse case — if the passage has FEWER markers than questions
      // (e.g. OCR missed half the blanks, or the question list was over-merged), trim
      // the question list down so each rendered question lines up with a real blank.
      if (passage && !passage.startsWith("[")) {
        const qCount = group.questions.length;
        const usesInlineMarkersHere = ["grammar-cloze", "editing", "comprehension-cloze", "vocab-cloze"].includes(group.key);
        const allMarkers: { num: number; fullMatch: string; index: number }[] = [];
        const markerRegex = /\*\*\((\d+)\)[^*]*\*\*/g;
        let mm;
        while ((mm = markerRegex.exec(passage)) !== null) {
          allMarkers.push({ num: parseInt(mm[1]), fullMatch: mm[0], index: mm.index });
        }
        if (allMarkers.length > qCount) {
          // Passage has too many markers — truncate the passage to the first qCount markers
          const lastKept = allMarkers[qCount - 1];
          const cutPoint = lastKept.index + lastKept.fullMatch.length;
          const nextNewline = passage.indexOf("\n", cutPoint);
          passage = passage.slice(0, nextNewline >= 0 ? nextNewline : cutPoint).trimEnd();
          console.log(`[English Quiz] ${group.label}: truncated passage to ${qCount} markers (was ${allMarkers.length})`);
        } else if (usesInlineMarkersHere && allMarkers.length > 0 && allMarkers.length < qCount) {
          // Passage has too few markers — trim the questions to match so we don't end
          // up rendering 10 questions next to a passage with only 5 blanks.
          const drop = group.questions.slice(allMarkers.length);
          group.questions = group.questions.slice(0, allMarkers.length);
          const dropIds = new Set(drop.map(q => q.id));
          for (let i = selectedExtra.length - 1; i >= 0; i--) {
            if (dropIds.has(selectedExtra[i].id)) selectedExtra.splice(i, 1);
          }
          console.warn(`[English Quiz] ${group.label}: trimmed ${drop.length} questions to match passage marker count (${allMarkers.length} markers, was ${qCount} questions)`);
        }

        // Rewrite remaining markers to match quiz numbering (position-based)
        let markerIdx = 0;
        passage = passage.replace(/\*\*\((\d+)\)/g, () => {
          const quizNum = idx + markerIdx + 1;
          markerIdx++;
          return `**(${quizNum})`;
        });
      }

      sections.push({
        label: `Section ${sectionLetter}: ${group.label}`,
        startIndex: idx,
        endIndex: idx + group.questions.length - 1,
        ...(passage ? { passage } : {}),
      });
      if (!passage && firstQ) {
        const meta = sourcePaperMap.get(firstQ.examPaperId);
        console.log(`[English Quiz] ${group.key}: NO passage. sectionOcrTexts keys: [${meta?.sectionOcrTexts ? Object.keys(meta.sectionOcrTexts).join(", ") : "none"}]`);
      }
      // Log passage details for debugging (skip marker check for sections that don't use inline markers)
      const usesInlineMarkers = ["grammar-cloze", "editing", "comprehension-cloze", "vocab-cloze"].includes(group.key);
      if (passage && !passage.startsWith("[")) {
        const markerCount = (passage.match(/\*\*\(\d+\)/g) ?? []).length;
        console.log(`[English Quiz] Section ${sectionLetter}: ${group.label} (Q${idx + 1}-${idx + group.questions.length}), passage: yes${usesInlineMarkers ? `, markers: ${markerCount}` : ""}`);
        if (usesInlineMarkers && markerCount !== group.questions.length) {
          console.warn(`[English Quiz] WARNING: passage has ${markerCount} markers but section has ${group.questions.length} questions!`);
          const markers = [...passage.matchAll(/\*\*\((\d+)\)/g)].map(m => m[1]);
          console.warn(`[English Quiz] Passage markers: [${markers.join(", ")}]`);
          console.warn(`[English Quiz] Question nums: [${group.questions.map(q => q.questionNum).join(", ")}]`);
        }
      } else {
        console.log(`[English Quiz] Section ${sectionLetter}: ${group.label} (Q${idx + 1}-${idx + group.questions.length}), passage: ${passage ? passage.substring(0, 40) : "no"}`);
      }
      idx += group.questions.length;
      sectionLetter = String.fromCharCode(sectionLetter.charCodeAt(0) + 1);
    }

    // Rebuild allSelected after any in-loop trimming so we don't try to create quiz
    // questions for IDs that were dropped to match the passage marker count.
    allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];

    // Hydrate selected questions with blob data
    const blobMap = await hydrateBlobs(allSelected.map(q => q.id));
    const allSelectedFull = allSelected.map(q => ({ ...q, ...blobMap.get(q.id) })) as FullQ[];

    // Use the SAME marksAvailable fallback that question creation uses below, so
    // paper.totalMarks matches the sum of per-question marksAvailable. Otherwise a
    // synthesis question with null marksAvailable ends up counted as 1 here and 2
    // there, and the student's percentage can go above 100%.
    const resolveMarks = (q: FullQ) => q.marksAvailable ?? ((q.syllabusTopic ?? "").toLowerCase().includes("synthesis") ? 2 : 1);
    const totalMarks = allSelectedFull.reduce((sum, q) => sum + resolveMarks(q), 0);
    const levelLabel = levelFilter ? `P${student!.level} ` : "";
    // Check if any non-MCQ sections are included
    const hasOeq = selectedExtra.some(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return t.includes("editing") || t.includes("cloze") || t.includes("synthesis") || t.includes("comprehension");
    });
    const engQuizType = hasOeq ? "MCQ + OEQ" : "MCQ";

    // Short section labels for the weekly-calendar title. Kept concise so the
    // title fits inside the day card without overflow.
    const shortSectionLabels: Record<string, string> = {
      "grammar-mcq": "Grammar MCQ",
      "vocab-mcq": "Vocab MCQ",
      "vocab-cloze": "Vocab Cloze",
      "visual-text": "Visual Text",
      "grammar-cloze": "Grammar Cloze",
      "editing": "Editing",
      "comprehension-cloze": "Compre Cloze",
      "synthesis": "Synthesis",
      "comprehension-oeq": "Compre OEQ",
    };
    const selectedSectionKeys = englishSections ?? [];
    const firstShort = selectedSectionKeys.length > 0
      ? (shortSectionLabels[selectedSectionKeys[0]] ?? selectedSectionKeys[0])
      : null;
    const extraMarker = selectedSectionKeys.length > 1 ? "+" : "";

    // Focused English: title by the selected section, e.g. "P5 Focus: Grammar Cloze"
    let engTitle: string;
    if (isFocusedEnglish && (englishSections?.length ?? 0) === 1) {
      const secKey = englishSections![0];
      const secLabel = sectionLabels[secKey] ?? secKey;
      engTitle = `${levelLabel}Focus: ${secLabel}`;
    } else if (firstShort) {
      // Daily English quiz: show the first selected section, with '+' if there are more.
      engTitle = `${levelLabel}${firstShort}${extraMarker}`;
    } else {
      engTitle = `${levelLabel}English Quiz ${engQuizType}`;
    }

    const paper = await prisma.examPaper.create({
      data: {
        title: engTitle,
        subject: "English Language",
        level: levelFilter || null,
        userId,
        assignedToId: targetStudentId,
        ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
        paperType: isFocusedEnglish ? "focused" : "quiz",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        metadata: {
          quizType: "mcq",
          englishSections: sections,
          sourceLabels: Object.fromEntries(
            allSelectedFull.map((q, i) => {
              const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
              return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
            })
          ),
        },
        questions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: allSelectedFull.map((q, i) => ({
            questionNum: String(i + 1),
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            marksAvailable: resolveMarks(q),
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
          })) as any,
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
      select: questionSelectLight,
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

    // Dedupe subparts by label — if multiple group members share the same label,
    // keep the first occurrence (which carries the diagram if any was attached).
    const seenLabels = new Set<string>();
    const uniqueSubparts: Subpart[] = [];
    for (const sp of allSubparts) {
      const key = sp.label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      uniqueSubparts.push(sp);
    }

    return {
      ...first,
      answer: combinedAnswer || first.answer,
      transcribedStem: combinedStem,
      // Preserve sentinels (like _drawable) even when there are no real sub-parts —
      // otherwise a single-part OEQ with a drawable diagram loses its canvas background.
      transcribedSubparts: (uniqueSubparts.length > 0 || sentinels.length > 0)
        ? [...uniqueSubparts, ...sentinels]
        : null,
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

  // Hydrate selected questions with blob data.
  // IMPORTANT: hydrateBlobs only fetches the FIRST question's blobs by id, but for merged OEQ
  // groups mergeOeqGroup may have already chosen diagramImageData from a non-first member as
  // a fallback. Don't let the hydrate clobber that — keep the merged value when it's set.
  const blobMap2 = await hydrateBlobs(allSelected.map(q => q.id));
  const allSelectedFull2 = allSelected.map(q => {
    const hydrated = blobMap2.get(q.id);
    const merged = { ...q, ...hydrated } as FullQ;
    if (q.diagramImageData && !merged.diagramImageData) merged.diagramImageData = q.diagramImageData;
    return merged;
  }) as FullQ[];

  const totalMarks = allSelectedFull2.reduce((sum, q) => sum + (isMcq(q.answer) ? 2 : (q.marksAvailable ?? 1)), 0);
  const levelLabel = levelFilter ? `P${student!.level} ` : "";

  const paper = await prisma.examPaper.create({
    data: {
      title: `${levelLabel}Daily Quiz – ${subject === "science" ? "Science" : "Math"} (${quizType === "mcq" ? "MCQ" : "MCQ + OEQ"})`,
      subject: subject === "science" ? "Science" : "Mathematics",
      level: levelFilter || null,
      userId,
      assignedToId: targetStudentId,
      ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        quizType,
        sourceLabels: Object.fromEntries(
          allSelectedFull2.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          })
        ),
      },
      questions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: allSelectedFull2.map((q, i) => ({
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
        })) as any,
      },
    },
  });

  return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
}
