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
  const levelFilter = student?.level ? `P${student.level}` : undefined;

  const questionWhere = (withLevel: boolean) => ({
    syllabusTopic: topic,
    answer: { not: null } as { not: null },
    // Note: do NOT filter by transcribedStem here — multi-part questions (e.g. Q38a, Q38bc)
    // may have the stem only on one part. Filtering by stem at query level drops the
    // other parts and breaks grouping. We filter at the group level below.
    examPaper: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: subject, mode: "insensitive" as const },
      ...(withLevel && levelFilter ? { level: levelFilter } : {}),
    },
  });

  let allQuestions = await prisma.examQuestion.findMany({
    where: questionWhere(true),
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
        select: { year: true, examType: true, school: true },
      },
    },
  });

  // Fallback: retry without level filter if nothing found
  if (allQuestions.length === 0 && levelFilter) {
    allQuestions = await prisma.examQuestion.findMany({
      where: questionWhere(false),
      select: {
        id: true, questionNum: true, examPaperId: true, imageData: true, answer: true,
        answerImageData: true, marksAvailable: true, syllabusTopic: true, transcribedStem: true,
        transcribedOptions: true, transcribedOptionImages: true, transcribedSubparts: true,
        diagramImageData: true, diagramBounds: true,
        examPaper: { select: { year: true, examType: true, school: true } },
      },
    });
  }

  if (allQuestions.length === 0) {
    return NextResponse.json({ error: "No questions found for this topic" }, { status: 404 });
  }

  type Q = typeof allQuestions[number];

  // ── MCQ pool: deduplicate by stem ─────────────────────────────────────────
  const mcqStemMap = new Map<string, Q>();
  for (const q of allQuestions) {
    if (!hasOptions(q)) continue;
    const stem = (q.transcribedStem ?? "").trim();
    if (stem) mcqStemMap.set(stem, q);
  }
  const mcqPool = [...mcqStemMap.values()];

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
  // Filter: keep only groups where at least one question has a stem
  const validGroups = [...oeqGroupMap.values()].filter(g => g.some(q => (q.transcribedStem ?? "").trim()));
  const oeqLeadStemMap = new Map<string, Q[]>();
  for (const group of validGroups) {
    const leadStem = (group.find(q => (q.transcribedStem ?? "").trim())?.transcribedStem ?? "").trim();
    if (leadStem) oeqLeadStemMap.set(leadStem, group);
  }
  const oeqPool = [...oeqLeadStemMap.values()];

  type Subpart = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };

  function mergeOeqGroup(group: Q[]) {
    const first = group[0];
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      if (q !== first && q.diagramImageData && realSubs.length > 0) {
        const diagramData = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
        allSubparts.push(...realSubs.map((sp, idx) =>
          idx === 0 && !sp.refImageBase64 ? { ...sp, refImageBase64: diagramData } : sp
        ));
      } else {
        allSubparts.push(...realSubs);
      }
    }
    const sentinels = group.flatMap(q => ((q.transcribedSubparts as Subpart[] | null) ?? []).filter(s => s.label.startsWith("_")));
    const stems = [...new Set(group.map(q => (q.transcribedStem ?? "").trim()).filter(Boolean))];
    const combinedAnswer = [...new Set(group.map(q => q.answer).filter(Boolean))].join("\n");
    return {
      ...first,
      answer: combinedAnswer || first.answer,
      transcribedStem: stems.join("\n"),
      transcribedSubparts: allSubparts.length > 0 ? [...allSubparts, ...sentinels] : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData: first.diagramImageData || group.find(q => q.diagramImageData)?.diagramImageData || null,
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
      level: levelFilter || null,
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

  return NextResponse.json({ id: paper.id });
}
