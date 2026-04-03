import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

function isMcq(answer: string | null): boolean {
  if (!answer) return false;
  const n = answer.trim().replace(/[().]/g, "").trim();
  return n === "1" || n === "2" || n === "3" || n === "4";
}

function baseNum(questionNum: string) {
  return questionNum.replace(/[a-zA-Z]+$/, "");
}

export async function POST(request: NextRequest) {
  const { parentId, studentId, subject, topic } = await request.json();

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
    transcribedStem: { not: null } as { not: null },
    answer: { not: null } as { not: null },
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
    if (!isMcq(q.answer)) continue;
    const stem = (q.transcribedStem ?? "").trim();
    if (stem) mcqStemMap.set(stem, q);
  }
  const mcqPool = [...mcqStemMap.values()];

  // ── OEQ pool: group by (paperId, baseNum), deduplicate groups by lead stem ─
  const oeqGroupMap = new Map<string, Q[]>();
  for (const q of allQuestions) {
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
  const targetMcq = Math.min(5, mcqPool.length);
  const targetOeq = Math.min(5, oeqPool.length);
  const remaining = 10 - targetMcq - targetOeq;
  const extraMcq = Math.min(remaining, mcqPool.length - targetMcq);
  const extraOeq = remaining - extraMcq > 0 ? Math.min(remaining - extraMcq, oeqPool.length - targetOeq) : 0;

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
      paperType: "focused",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(allSelected.reduce((sum, q) => sum + (isMcq(q.answer) ? 2 : (q.marksAvailable ?? 1)), 0)),
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

  return NextResponse.json({ id: paper.id });
}
