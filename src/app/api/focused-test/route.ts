import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** MCQ = question has transcribed options (4-element array) or image options. */
function hasOptions(q: { transcribedOptions?: unknown; transcribedOptionImages?: unknown }): boolean {
  const opts = q.transcribedOptions;
  const imgs = q.transcribedOptionImages;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  return false;
}

function baseNum(questionNum: string) {
  return questionNum.replace(/[a-zA-Z]+$/, "");
}

export async function POST(request: NextRequest) {
  const { parentId, studentId, subject, topic, scheduledFor, type } = await request.json();
  const scheduledForDate = scheduledFor ? new Date(scheduledFor) : undefined;
  const mcqOnly = type === "mcq";

  if (!parentId || !subject || !topic) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { level: true },
  });
  // Source papers have inconsistent level formatting ("P5", "Primary 5", "5").
  // Accept all equivalent variants so the filter actually works.
  const levelVariants = student?.level
    ? [`P${student.level}`, `Primary ${student.level}`, String(student.level)]
    : undefined;

  const questionWhere = (useLevel: boolean) => ({
    syllabusTopic: topic,
    answer: { not: null } as { not: null },
    // Note: do NOT filter by transcribedStem here — multi-part questions (e.g. Q38a, Q38bc)
    // may have the stem only on one part. Filtering by stem at query level drops the
    // other parts and breaks grouping. We filter at the group level below.
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subject, mode: "insensitive" as const },
      ...(useLevel && levelVariants ? { level: { in: levelVariants } } : {}),
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
    sourceQuestionId: true,
    examPaper: {
      select: { year: true, examType: true, school: true, level: true },
    },
  } as const;

  let topicMatched = await prisma.examQuestion.findMany({
    where: questionWhere(true),
    select: questionSelect,
  });
  // If the student-level filter zeroed out but the topic exists in the bank at
  // other levels, fall back to "any level" so English master papers tagged with
  // e.g. level="Primary 5" don't hide from a student whose level is stored as 5.
  let levelFallback = false;
  if (topicMatched.length === 0 && levelVariants) {
    topicMatched = await prisma.examQuestion.findMany({
      where: questionWhere(false),
      select: questionSelect,
    });
    levelFallback = topicMatched.length > 0;
  }

  if (topicMatched.length === 0) {
    // Diagnostic: tell the caller how many matched each relaxation so they can
    // tell "topic truly missing" from "subject mismatch" from "level mismatch".
    const anySubjectCount = await prisma.examQuestion.count({
      where: {
        syllabusTopic: topic,
        answer: { not: null },
        examPaper: { sourceExamId: null, paperType: null },
      },
    });
    return NextResponse.json({
      error: anySubjectCount > 0
        ? `No clean questions found for "${topic}" in ${subject} master papers. (${anySubjectCount} exist under other subjects.)`
        : `No clean questions found for "${topic}" in any master paper yet.`,
    }, { status: 404 });
  }

  // Pull in every DB sibling for each (examPaperId, baseNum) in the topic-matched set.
  // The topic filter can miss the parent row when only the subpart carries the syllabus
  // topic tag — and the parent is often the row with the diagram/lead stem. Without
  // this, a subpart like "Express the number of lemon muffins..." gets pulled on its
  // own and shows up in practice with no pie chart.
  const siblingKeys = new Set<string>();
  for (const q of topicMatched) siblingKeys.add(`${q.examPaperId}::${baseNum(q.questionNum)}`);
  const siblingWheres = [...siblingKeys].map(k => {
    const [examPaperId, base] = k.split("::");
    return { examPaperId, questionNum: { startsWith: base } };
  });
  const siblings = siblingWheres.length > 0
    ? await prisma.examQuestion.findMany({
        where: { OR: siblingWheres, answer: { not: null } as { not: null } },
        select: questionSelect,
      })
    : [];

  const byId = new Map<string, typeof topicMatched[number]>();
  for (const q of topicMatched) byId.set(q.id, q);
  for (const q of siblings) if (!byId.has(q.id)) byId.set(q.id, q);
  const allQuestions = [...byId.values()];

  type Q = typeof allQuestions[number];

  // Normalise a stem for dedup: the same question phrased with different
  // whitespace, punctuation, or a leading question number (e.g. "1. What...",
  // "Q1 What...", "(1) What...") should collapse to one entry. Without this
  // the pool leaks near-duplicates — e.g. the same Science "Light" question
  // copied across several WA2 papers — and the student sees the same question
  // twice in a 10-item practice.
  function normaliseStem(s: string): string {
    return s
      .toLowerCase()
      .replace(/^\s*(?:q\.?\s*)?\(?\s*\d{1,3}\s*[).:]\s*/, "") // leading "1.", "Q1)", "(1):", etc.
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // ── MCQ pool: deduplicate by lineage + normalised stem ──
  // Lineage: a synthetic-bank question carries sourceQuestionId pointing back
  // to the original ExamQuestion. Both `simple` and `similar` variants share
  // that lineage, AND the source's own id equals that lineage. So the source
  // and its variants collapse to ONE entry. This matters because `simple` has
  // a stem nearly identical to the source (only numbers change) which the
  // stem-normaliser alone can't collapse for math.
  const mcqPool: Q[] = [];
  const seenMcqLineages = new Set<string>();
  const seenMcqStems = new Set<string>();
  for (const q of allQuestions) {
    if (!hasOptions(q)) continue;
    const lineage = q.sourceQuestionId || q.id;
    if (seenMcqLineages.has(lineage)) continue;
    const norm = normaliseStem(q.transcribedStem ?? "");
    if (norm && seenMcqStems.has(norm)) continue;
    seenMcqLineages.add(lineage);
    if (norm) seenMcqStems.add(norm);
    mcqPool.push(q);
  }

  // ── OEQ pool: group by (paperId, baseNum), deduplicate groups by lead stem ─
  // Include ALL questions in the group (even stem-less), since multi-part questions
  // like Q38a (stem-only) + Q38bc (sub-parts) must be kept together.
  const oeqGroupMap = new Map<string, Q[]>();
  for (const q of allQuestions) {
    if (hasOptions(q)) continue;
    const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
    if (!oeqGroupMap.has(key)) oeqGroupMap.set(key, []);
    oeqGroupMap.get(key)!.push(q);
  }
  for (const group of oeqGroupMap.values()) {
    group.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }
  // Keep groups that either have a stem OR an image. Image-only English OEQs
  // (Grammar Cloze, Editing, Comp Cloze) should still be selectable — the quiz
  // UI falls back to rendering imageData when transcribedStem is null.
  const validGroups = [...oeqGroupMap.values()].filter(g =>
    g.some(q => (q.transcribedStem ?? "").trim() || (q.imageData && q.imageData.length > 100))
  );
  // Dedup OEQ groups by lineage + normalised lead stem (same rationale as MCQ).
  const oeqPool: Q[][] = [];
  const seenOeqLineages = new Set<string>();
  const seenOeqStems = new Set<string>();
  for (const group of validGroups) {
    const rawLeadStem = (group.find(q => (q.transcribedStem ?? "").trim())?.transcribedStem ?? "").trim();
    const norm = normaliseStem(rawLeadStem);
    // Group lineage = lineage of any sibling; pick the first since all siblings
    // under the same (paperId, baseNum) share a source.
    const lineage = group[0].sourceQuestionId || group[0].id;
    if (seenOeqLineages.has(lineage)) continue;
    if (norm && seenOeqStems.has(norm)) continue;
    seenOeqLineages.add(lineage);
    if (norm) seenOeqStems.add(norm);
    oeqPool.push(group);
  }

  type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };

  function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!answer || !answer.trim()) return result;
    const re = /(^|[|\n])\s*\(?([a-z])\)\s*/gi;
    const matches = [...answer.matchAll(re)];
    if (matches.length === 0) return result;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const label = m[2].toLowerCase();
      const start = m.index! + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index! : answer.length;
      const content = answer.slice(start, end).replace(/\s*\|\s*$/, "").trim();
      if (content) result.set(label, content);
    }
    return result;
  }

  function mergeOeqGroup(group: Q[]) {
    const first = group[0];
    // The "stem source" is whichever sibling supplies the main question stem:
    // normally group[0] (e.g. 38a), but if 38a has no stem (the part carries only
    // a subpart label) we fall back to the first sibling that HAS a stem. That
    // same sibling must then be treated as "first" for extra-stem prepending and
    // diagram attachment — otherwise we'd prepend its stem onto its own subpart
    // text and the student sees the stem AND the diagram twice.
    const stemSource = (first.transcribedStem ?? "").trim()
      ? first
      : (group.find(q => (q.transcribedStem ?? "").trim()) ?? first);
    const leadStem = (stemSource.transcribedStem ?? "").trim();
    const diagramSource = first.diagramImageData
      ? first
      : (group.find(q => q.diagramImageData) ?? first);
    // imageData is the cropped question snapshot the quiz UI falls back to
    // when transcribedStem is empty. If group[0] has none (e.g. only 9b was
    // tagged with the topic and 9b's image is blank), pick from any sibling
    // that actually has a substantial image. Without this, the student sees
    // a blank card.
    const imageSource = (first.imageData && first.imageData.length > 100)
      ? first
      : (group.find(q => q.imageData && q.imageData.length > 100) ?? first);
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      const qStem = (q.transcribedStem ?? "").trim();
      const extraStem = q !== stemSource && qStem && qStem !== leadStem ? qStem : "";
      const processed = realSubs.map((sp, idx) => {
        let next = sp;
        if (idx === 0 && extraStem) {
          next = { ...next, text: `${extraStem}\n\n${sp.text ?? ""}`.trim() };
        }
        if (q !== diagramSource && q.diagramImageData && idx === 0 && !next.refImageBase64) {
          const diagramData = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
          next = { ...next, refImageBase64: diagramData };
        }
        return next;
      });
      allSubparts.push(...processed);
    }
    const sentinels = group.flatMap(q => ((q.transcribedSubparts as Subpart[] | null) ?? []).filter(s => s.label.startsWith("_")));
    // Aggregate per-part answers across all siblings, then attach to subparts.
    // Also rebuild the flat answer string from the per-part map so every part is present.
    const partAnswers = new Map<string, string>();
    for (const q of group) {
      const parsed = parsePartAnswers(q.answer);
      if (parsed.size > 0) {
        for (const [label, text] of parsed) partAnswers.set(label, text);
        continue;
      }
      // No (a)/(b) markers — if this sibling has exactly one real subpart, use its label
      const sibSubs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
      if (sibRealSubs.length === 1 && q.answer?.trim()) {
        partAnswers.set(sibRealSubs[0].label.toLowerCase(), q.answer.trim());
      }
    }
    const enrichedSubparts = allSubparts.map(sp => {
      const ans = partAnswers.get(sp.label.toLowerCase());
      return ans !== undefined ? { ...sp, answer: ans } : sp;
    });
    const rebuiltAnswer = partAnswers.size > 0
      ? [...partAnswers.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `(${k}) ${v}`).join(" | ")
      : [...new Set(group.map(q => q.answer).filter(Boolean))].join("\n");
    // Pick the first answer image among siblings (in questionNum order).
    const sortedGroup = [...group].sort((a,b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
    const answerImageData = sortedGroup.find(q => q.answerImageData)?.answerImageData ?? first.answerImageData ?? null;
    return {
      ...first,
      imageData: imageSource.imageData,
      answer: rebuiltAnswer || first.answer,
      answerImageData,
      transcribedStem: leadStem,
      transcribedSubparts: enrichedSubparts.length > 0 ? [...enrichedSubparts, ...sentinels] : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData: diagramSource.diagramImageData ?? null,
    };
  }

  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
  shuffle(mcqPool);
  shuffle(oeqPool);

  // Take up to 5 MCQ + up to 5 OEQ; fill remaining slots from whichever has more
  // When mcqOnly, use only MCQ pool for all 10 slots
  const targetMcq = mcqOnly ? Math.min(10, mcqPool.length) : Math.min(5, mcqPool.length);
  const targetOeq = mcqOnly ? 0 : Math.min(5, oeqPool.length);
  const remaining = 10 - targetMcq - targetOeq;
  const extraMcq = Math.min(remaining, mcqPool.length - targetMcq);
  const extraOeq = !mcqOnly && remaining - extraMcq > 0 ? Math.min(remaining - extraMcq, oeqPool.length - targetOeq) : 0;

  const selectedMcq = mcqPool.slice(0, targetMcq + extraMcq);
  const selectedOeq = oeqPool.slice(0, targetOeq + extraOeq).map(mergeOeqGroup);
  const allSelected = [...selectedMcq, ...selectedOeq];

  if (allSelected.length === 0) {
    return NextResponse.json({ error: "No clean questions found for this topic" }, { status: 404 });
  }

  const levelLabel = student?.level ? `P${student.level} ` : "";
  const paper = await prisma.examPaper.create({
    data: {
      title: `${levelLabel}Focused: ${topic}`,
      subject,
      level: student?.level ? `P${student.level}` : null,
      userId: parentId,
      assignedToId: studentId || null,
      ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
      paperType: "focused",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(allSelected.reduce((sum, q) => sum + (hasOptions(q) ? 2 : (q.marksAvailable ?? 1)), 0)),
      questions: {
        create: allSelected.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: hasOptions(q) ? 2 : (q.marksAvailable ?? 1),
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

  // Build a human warning if the topic had fewer questions than the default target.
  // Default target = 10 (mcqOnly) or 5 MCQ + 5 OEQ (mixed). Surface shortfall so the
  // assigner knows the practice is shorter than usual.
  const warnings: string[] = [];
  const levelName = student?.level ? `P${student.level}` : "this level";
  if (levelFallback) {
    const levelsUsed = [...new Set(topicMatched.map(q => q.examPaper.level).filter(Boolean))].join(", ");
    warnings.push(`No ${levelName} papers for "${topic}" yet — pulled from ${levelsUsed || "other levels"} instead.`);
  }
  if (mcqOnly) {
    if (mcqPool.length < 10) {
      warnings.push(`Only ${mcqPool.length} MCQ question${mcqPool.length === 1 ? "" : "s"} available for "${topic}" at ${levelName}. Practice is shorter than the usual 10.`);
    }
  } else {
    if (oeqPool.length === 0 && mcqPool.length > 0) {
      warnings.push(`No written questions are tagged for "${topic}" at ${levelName} yet — this practice is MCQ-only.`);
    } else if (mcqPool.length === 0 && oeqPool.length > 0) {
      warnings.push(`No MCQ questions are tagged for "${topic}" at ${levelName} yet — this practice is written-only.`);
    } else if (mcqPool.length + oeqPool.length < 10) {
      warnings.push(`Only ${mcqPool.length} MCQ + ${oeqPool.length} written question(s) available for "${topic}" at ${levelName}. Practice is shorter than the usual 10.`);
    }
  }

  return NextResponse.json({ id: paper.id, questionCount: allSelected.length, warnings });
}
