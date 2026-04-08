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

  const questionSelect = {
    id: true,
    questionNum: true,
    examPaperId: true,
    imageData: true,
    answer: true,
    answerImageData: true,
    marksAvailable: true,
    syllabusTopic: true,
    pageIndex: true,
    transcribedStem: true,
    transcribedOptions: true,
    transcribedOptionImages: true,
    transcribedSubparts: true,
    diagramImageData: true,
    diagramBounds: true,
    examPaper: {
      select: { id: true, year: true, examType: true, school: true, pageCount: true },
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

    // Select Grammar/Vocab MCQ based on user choices
    const selectedSections = new Set(englishSections ?? ["grammar-mcq", "vocab-mcq", "vocab-cloze"]);
    console.log(`[English Quiz] Pools: grammar=${grammarMcqPool.length}, vocab=${vocabMcqPool.length}, vocabCloze=${vocabClozeSets.length} sets, visualText=${visualTextSets.length} sets`);
    const selectedGrammar = selectedSections.has("grammar-mcq") ? grammarMcqPool.slice(0, 5) : [];
    const selectedVocab = selectedSections.has("vocab-mcq") ? vocabMcqPool.slice(0, 5) : [];
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
      "comprehension-oeq": t => t.includes("comprehension") && t.includes("open"),
    };

    // Fixed order: MCQ sections first (Vocab Cloze, Visual Text), then OEQ sections
    const sectionOrder = ["vocab-cloze", "visual-text", "grammar-cloze", "editing", "comprehension-cloze", "synthesis", "comprehension-oeq"];
    const orderedSections = sectionOrder.filter(s => selectedSections.has(s));

    for (const section of orderedSections) {
      let sectionQs: typeof allPool = [];
      if (section === "vocab-cloze" && vocabClozeSets.length > 0) {
        sectionQs = vocabClozeSets[0];
      } else if (section === "visual-text" && visualTextSets.length > 0) {
        sectionQs = visualTextSets[0];
      } else if (section === "synthesis") {
        const synthPool = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("synthesis"));
        shuffle(synthPool);
        sectionQs = synthPool.slice(0, 5);
      } else {
        const matcher = topicMatchers[section];
        if (matcher) {
          const matchedQs = allPool.filter(q => matcher((q.syllabusTopic ?? "").toLowerCase()));
          const papers = new Map<string, typeof allPool>();
          for (const q of matchedQs) {
            if (!papers.has(q.examPaperId)) papers.set(q.examPaperId, []);
            papers.get(q.examPaperId)!.push(q);
          }
          const paperSets = shuffle([...papers.values()]);
          if (paperSets.length > 0) sectionQs = paperSets[0];
        }
      }
      if (sectionQs.length > 0) {
        // Sort by original question number to match passage marker order
        sectionQs.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
        selectedExtra.push(...sectionQs);
        activeLabels.push(sectionLabels[section] ?? section);
        extraSectionGroups.push({ key: section, label: sectionLabels[section] ?? section, questions: sectionQs });
      }
    }

    const allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];
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
        // Try 1: transcribedSubparts sentinel
        const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }> | null;
        const passageSub = subs?.find(s => s.label === "_passage");
        if (passageSub) { passage = passageSub.text; }

        // Try 2: source paper's sectionOcrTexts (pre-fetched batch)
        // Skip for sections that don't use inline passage markers
        const skipOcrLookup = group.key === "visual-text" || group.key === "synthesis";
        // Comprehension OEQ: load the reading passage (passageOcrText), not the question OCR
        if (!passage && group.key === "comprehension-oeq") {
          const meta = sourcePaperMap.get(firstQ.examPaperId);
          if (meta?.sectionOcrTexts) {
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              if (secName.toLowerCase().includes("comprehension") && (secName.toLowerCase().includes("open") || secName.toLowerCase().includes("oeq"))) {
                const passageText = (secData as { passageOcrText?: string }).passageOcrText;
                if (passageText) {
                  passage = passageText;
                  console.log(`[English Quiz] Comp OEQ: loaded reading passage (${passageText.length} chars) from "${secName}"`);
                }
                break;
              }
            }
          }
          if (!passage) console.log(`[English Quiz] Comp OEQ: no reading passage found in sectionOcrTexts`);
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

      // Clean passage: keep only the first N markers, truncate after the last one
      if (passage && !passage.startsWith("[")) {
        const qCount = group.questions.length;
        const allMarkers: { num: number; fullMatch: string; index: number }[] = [];
        const markerRegex = /\*\*\((\d+)\)[^*]*\*\*/g;
        let mm;
        while ((mm = markerRegex.exec(passage)) !== null) {
          allMarkers.push({ num: parseInt(mm[1]), fullMatch: mm[0], index: mm.index });
        }
        if (allMarkers.length > qCount) {
          // Truncate passage right after the last kept marker (removes other section content entirely)
          const lastKept = allMarkers[qCount - 1];
          const cutPoint = lastKept.index + lastKept.fullMatch.length;
          // Keep a bit after the last marker (rest of the sentence/line)
          const nextNewline = passage.indexOf("\n", cutPoint);
          passage = passage.slice(0, nextNewline >= 0 ? nextNewline : cutPoint).trimEnd();
          console.log(`[English Quiz] Truncated passage after marker ${qCount} (removed ${allMarkers.length - qCount} extra markers)`);
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
      // Log passage details for debugging
      if (passage && !passage.startsWith("[")) {
        const markerCount = (passage.match(/\*\*\(\d+\)/g) ?? []).length;
        console.log(`[English Quiz] Section ${sectionLetter}: ${group.label} (Q${idx + 1}-${idx + group.questions.length}), passage: yes, markers: ${markerCount}, questions: ${group.questions.length}`);
        if (markerCount !== group.questions.length) {
          console.warn(`[English Quiz] WARNING: passage has ${markerCount} markers but section has ${group.questions.length} questions!`);
          // Extract marker numbers for debugging
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
            marksAvailable: q.marksAvailable ?? ((q.syllabusTopic ?? "").toLowerCase().includes("synthesis") ? 2 : 1),
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
