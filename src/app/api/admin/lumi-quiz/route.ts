// POST /api/admin/lumi-quiz
//
// Build a fresh, personalised quiz where every question is drilled
// against the SAME skill tag — independent of topic. Used by Lumi's
// "skill-across-topics" intervention.
//
//   Body: { studentId, subject, skillTag, count }
//     subject  : 'science'   (only one supported until we add other-subject skill tags)
//     skillTag : 'graph-trend-describe' | 'evidence-then-conclusion'
//                | 'precise-vocabulary' | 'diagram-interpretation'
//                | 'direction-of-relationship'
//     count    : how many questions in the quiz (default 10, max 30)
//
// The endpoint mirrors student-revision's shape on purpose:
//   · Same auth model (admin / linked parent / student themselves)
//   · Same paper-create flow (paperType="quiz", isRevision=true,
//     instantFeedback=true) so the existing /quiz/[id] player + the
//     review surface both "just work" with no special-casing
//   · metadata.revisionMode is set to "lumi-skill" — a different
//     value from the Revise Work flow's "review" / "practice" so
//     weak-topics.ts and tutor.ts still exclude these clones from
//     diagnosis (avoids double-counting), and so the dashboard
//     surfaces them in their own pile rather than mixed in with
//     Revise Work papers.
//
// Question picker (the only new bit):
//   1. Pull masters where skillTags array CONTAINS the requested tag,
//      excluding any master the kid has already attempted (deduped
//      via sourceQuestionId on the kid's clones).
//   2. Order by [difficulty ASC, randomShuffle within difficulty bucket]
//      so the quiz scaffolds easy → hard but doesn't always serve the
//      same questions in the same order.
//   3. Slice to `count`.
//
// Preamble + postamble generation is OUT OF SCOPE for v1 — this
// endpoint just builds the question paper. The /quiz/[id] player
// already renders the questions; Lumi-specific preamble copy can be
// stamped onto paper.metadata.lumiPreamble in a follow-up.

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { SCIENCE_SKILL_TAGS, type ScienceSkillTag } from "@/lib/science-skills";

const SUBJECT_FULL: Record<"science", string> = {
  science: "Science",
};

export async function POST(request: NextRequest) {
  const callerId = await getSessionUserId();
  if (!callerId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { studentId?: string; subject?: string; skillTag?: string; count?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const { studentId, subject, skillTag } = body;
  const requestedCount = body.count ?? 10;

  // Validation
  if (!studentId || !subject || !skillTag) {
    return NextResponse.json({ error: "studentId, subject, skillTag required" }, { status: 400 });
  }
  if (subject !== "science") {
    return NextResponse.json({ error: "only 'science' supported in v1" }, { status: 400 });
  }
  if (!(SCIENCE_SKILL_TAGS as readonly string[]).includes(skillTag)) {
    return NextResponse.json({ error: `invalid skillTag (must be one of: ${SCIENCE_SKILL_TAGS.join(", ")})` }, { status: 400 });
  }
  const count = Math.max(3, Math.min(30, Number.isInteger(requestedCount) ? requestedCount : 10));

  // Auth: admin / the student / linked parent
  const callerIsAdmin = await isSessionAdmin();
  if (!callerIsAdmin && callerId !== studentId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: callerId, studentId } },
      select: { id: true },
    });
    if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, level: true, role: true },
  });
  if (!student || student.role !== "STUDENT") {
    return NextResponse.json({ error: "student not found" }, { status: 404 });
  }

  // ── Question picker ─────────────────────────────────────────────
  // Step 1: every master ID the kid has already attempted (deduped
  // via sourceQuestionId on the kid's clones). Lumi shouldn't serve
  // up Qs the kid has seen — drilling the SAME question doesn't
  // rebuild the skill, it just rote-memorises the specific answer.
  const attemptedMasterIds = await prisma.examQuestion.findMany({
    where: {
      examPaper: { OR: [{ userId: studentId }, { assignedToId: studentId }] },
      sourceQuestionId: { not: null },
    },
    select: { sourceQuestionId: true },
  });
  const seenIds = new Set(attemptedMasterIds.map(r => r.sourceQuestionId).filter((x): x is string => !!x));

  // Step 2: master pool for this skill, EXCLUDING what the kid has seen.
  const masterPool = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
      },
      // skillTags is a String[] column; `has` matches when the array
      // contains the value (Postgres array @> operator).
      skillTags: { has: skillTag as ScienceSkillTag },
      // Belt + suspenders: skill tags only get persisted on >=2 mark
      // OEQs (see scripts/classify-science-skills.ts eligibility),
      // but re-assert here so a stray manual tag on a 1-mark MCQ
      // can't sneak into a Lumi quiz.
      marksAvailable: { gte: 2 },
      id: { notIn: [...seenIds] },
    },
    select: {
      id: true,
      questionNum: true,
      imageData: true,
      answer: true,
      answerImageData: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedSubparts: true,
      diagramBounds: true,
      diagramImageData: true,
      marksAvailable: true,
      syllabusTopic: true,
      subTopic: true,
      difficulty: true,
      examPaper: { select: { level: true, title: true, year: true } },
    },
  });

  if (masterPool.length < 3) {
    return NextResponse.json({
      error: "not enough unseen questions for this skill",
      detail: `Only ${masterPool.length} unseen masters available with skillTag="${skillTag}". Kid has likely already attempted most of them.`,
    }, { status: 404 });
  }

  // Step 3: order by difficulty ASC with shuffle within bucket so
  // repeat Lumi quizzes on the same skill don't serve identical sets.
  // Difficulty null treated as 3 (middle) so untyped questions don't
  // all land at one extreme.
  const buckets = new Map<number, typeof masterPool>();
  for (const q of masterPool) {
    const d = q.difficulty ?? 3;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d)!.push(q);
  }
  for (const list of buckets.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  // Take in ascending-difficulty order until we hit `count`. Smaller
  // buckets (e.g. difficulty=5) contribute fewer Qs by their nature,
  // which lines up with the "scaffold easy → hard" shape we want.
  const ordered: typeof masterPool = [];
  for (const d of [...buckets.keys()].sort((a, b) => a - b)) {
    for (const q of buckets.get(d)!) {
      ordered.push(q);
      if (ordered.length >= count) break;
    }
    if (ordered.length >= count) break;
  }
  const picked = ordered.slice(0, count);

  // ── Build the question creates ───────────────────────────────────
  type QuestionCreate = Prisma.ExamQuestionCreateWithoutExamPaperInput;
  const questionCreates: QuestionCreate[] = picked.map((m, i) => ({
    questionNum: String(i + 1),
    imageData: m.imageData ?? "",
    answer: m.answer,
    answerImageData: m.answerImageData,
    pageIndex: 0,
    orderIndex: i,
    marksAvailable: m.marksAvailable,
    syllabusTopic: m.syllabusTopic,
    subTopic: m.subTopic,
    transcribedStem: m.transcribedStem,
    transcribedOptions: (m.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    transcribedOptionImages: (m.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    transcribedSubparts: (m.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    diagramBounds: (m.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    diagramImageData: m.diagramImageData,
    // sourceQuestionId points at the master so dedup-by-source on
    // future Lumi-quiz runs WILL exclude this question — drilling
    // the same Q twice doesn't help.
    sourceQuestionId: m.id,
  }));

  const totalMarks = picked.reduce((sum, q) => sum + (Number(q.marksAvailable) || 1), 0);
  const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Singapore" });
  const levelLabel = student.level ? `P${student.level} ` : "";
  // Title is parent-facing on the dashboard — say what the quiz is
  // about, not "Lumi-skill-XYZ Quiz".
  const skillTitle = SKILL_TITLE[skillTag as ScienceSkillTag];
  const title = `${levelLabel}Science: ${skillTitle} ${dateLabel}`;

  const paper = await prisma.examPaper.create({
    data: {
      title,
      subject: SUBJECT_FULL[subject as "science"],
      level: student.level ? `Primary ${student.level}` : null,
      userId: callerId,
      assignedToId: studentId,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      // Lumi quizzes are a curated PRACTICE set, not a fresh
      // assessment — flag the same way Revise Work practice papers
      // are flagged so weak-topics + tutor diagnoses don't double-
      // count their results when the kid attempts them.
      isRevision: true,
      metadata: {
        revisionMode: "lumi-skill",
        lumiSkillTag: skillTag,
        lumiSubject: subject,
        compiledAt: new Date().toISOString(),
        compiledBy: callerId,
      },
      questions: { create: questionCreates },
    },
    select: { id: true },
  });

  return NextResponse.json({
    paperId: paper.id,
    title,
    questionCount: picked.length,
    skillTag,
    redirectUrl: `/quiz/${paper.id}?userId=${callerId}`,
  });
}

const SKILL_TITLE: Record<ScienceSkillTag, string> = {
  "graph-trend-describe":     "Graph reading",
  "evidence-then-conclusion": "Evidence + reason",
  "precise-vocabulary":       "Scientific vocabulary",
  "diagram-interpretation":   "Reading diagrams",
  "direction-of-relationship": "How variables relate",
};
