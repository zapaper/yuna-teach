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
import { SCIENCE_SKILL_TAGS, SCIENCE_SKILL_PREAMBLE, type ScienceSkillTag, type LumiPreamble } from "@/lib/science-skills";
import { LUMI_QUIZ_COMBOS, type LumiQuizCombo } from "@/lib/lumi-combos";

const SUBJECT_FULL: Record<"science", string> = {
  science: "Science",
};

export async function POST(request: NextRequest) {
  const callerId = await getSessionUserId();
  if (!callerId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Two entry shapes, both supported:
  //   · combo path  — { studentId, subject, comboIdx, count? }
  //     Pulls a hardcoded LumiQuizCombo (topic + sub-topic weights +
  //     skill + topic recap) and runs the weighted picker. Used by the
  //     2-button CTA in LumiSummary (the customer-facing surface).
  //   · skill path — { studentId, subject, skillTag, count? }
  //     The original direct-skill picker. Kept so the /admin sandbox
  //     can still drill a single skill without going through a combo.
  let body: { studentId?: string; subject?: string; skillTag?: string; comboIdx?: number; count?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const { studentId, subject, skillTag, comboIdx } = body;
  const requestedCount = body.count ?? 10;

  // Validation
  if (!studentId || !subject) {
    return NextResponse.json({ error: "studentId and subject required" }, { status: 400 });
  }
  if (subject !== "science") {
    return NextResponse.json({ error: "only 'science' supported in v1" }, { status: 400 });
  }
  if (typeof comboIdx === "number") {
    const combos = LUMI_QUIZ_COMBOS[studentId];
    if (!combos || comboIdx < 0 || comboIdx >= combos.length) {
      return NextResponse.json({ error: `no combo at index ${comboIdx} for this student` }, { status: 400 });
    }
  } else if (skillTag) {
    if (!(SCIENCE_SKILL_TAGS as readonly string[]).includes(skillTag)) {
      return NextResponse.json({ error: `invalid skillTag (must be one of: ${SCIENCE_SKILL_TAGS.join(", ")})` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "either comboIdx or skillTag required" }, { status: 400 });
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

  // Resolve the active target — either the combo's (topic, sub-topic
  // weights, skill) tuple or just a free-standing skill tag.
  const activeCombo: LumiQuizCombo | null =
    typeof comboIdx === "number" ? LUMI_QUIZ_COMBOS[studentId][comboIdx] : null;
  const activeSkillTag = (activeCombo?.skillTag ?? skillTag) as ScienceSkillTag;
  const activeTopic = activeCombo?.topic ?? null;
  const activeSubTopicWeights = activeCombo?.subTopicWeights ?? null;

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

  // Step 2: master pool. For the combo path, scope by TOPIC and let
  // the picker prefer skill-tagged Qs from within that pool. For the
  // skill-only path, scope by SKILL — the existing behaviour.
  // Belt + suspenders marksAvailable ≥ 2 + master-paper filter applies
  // to both paths.
  const masterPool = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
      },
      marksAvailable: { gte: 2 },
      id: { notIn: [...seenIds] },
      ...(activeTopic
        ? { syllabusTopic: activeTopic }
        : { skillTags: { has: activeSkillTag } }),
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
      skillTags: true,
      difficulty: true,
      examPaper: { select: { level: true, title: true, year: true } },
    },
  });

  if (masterPool.length < 3) {
    return NextResponse.json({
      error: "not enough unseen questions",
      detail: activeTopic
        ? `Only ${masterPool.length} unseen masters in topic "${activeTopic}". Kid has likely already attempted most of them.`
        : `Only ${masterPool.length} unseen masters with skillTag="${activeSkillTag}".`,
    }, { status: 404 });
  }

  // Difficulty-shuffle helper: shuffle within each difficulty bucket,
  // then return Qs in ascending-difficulty order. Used by every picker
  // path so repeat quizzes don't serve identical sets.
  const orderByDifficulty = (pool: typeof masterPool): typeof masterPool => {
    const buckets = new Map<number, typeof masterPool>();
    for (const q of pool) {
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
    const out: typeof masterPool = [];
    for (const d of [...buckets.keys()].sort((a, b) => a - b)) {
      out.push(...buckets.get(d)!);
    }
    return out;
  };

  // Step 3: pick `count` Qs from the pool.
  //   · Combo path with sub-topic weights: for each sub-topic in the
  //     weights map, take that many Qs, preferring skill-tagged ones.
  //     Fill any shortfall by relaxing the skill preference, then
  //     by pulling from other sub-topics in the same topic.
  //   · Combo path without weights: take `count`, preferring skill-
  //     tagged Qs.
  //   · Skill-only path: just difficulty-shuffle and slice.
  const picked: typeof masterPool = [];
  const pickedIds = new Set<string>();
  const takeSkillFirst = (pool: typeof masterPool, n: number) => {
    const ordered = orderByDifficulty(pool);
    const withSkill = ordered.filter(q => q.skillTags.includes(activeSkillTag));
    const without = ordered.filter(q => !q.skillTags.includes(activeSkillTag));
    const taken: typeof masterPool = [];
    for (const q of [...withSkill, ...without]) {
      if (taken.length >= n) break;
      if (pickedIds.has(q.id)) continue;
      taken.push(q);
      pickedIds.add(q.id);
    }
    return taken;
  };

  if (activeSubTopicWeights) {
    for (const [subTopic, weight] of Object.entries(activeSubTopicWeights)) {
      const subPool = masterPool.filter(q => q.subTopic === subTopic);
      picked.push(...takeSkillFirst(subPool, weight));
    }
    // Top up the rest from any remaining topic Qs, skill-first.
    if (picked.length < count) {
      const remaining = masterPool.filter(q => !pickedIds.has(q.id));
      picked.push(...takeSkillFirst(remaining, count - picked.length));
    }
  } else {
    picked.push(...takeSkillFirst(masterPool, count));
  }
  // Trim if over.
  picked.length = Math.min(picked.length, count);

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
  // about. Combo path uses the combo's label ("Electrical + Evidence
  // + reason"); skill-only path uses the skill's title.
  const titleSegment = activeCombo
    ? activeCombo.label
    : SKILL_TITLE[activeSkillTag];
  const title = `${levelLabel}Science: ${titleSegment} ${dateLabel}`;

  // Build the two-part preamble. Combo path stamps both topic + skill
  // halves. Skill-only path stamps the skill block alone.
  const skillBlock = SCIENCE_SKILL_PREAMBLE[activeSkillTag];
  const lumiPreamble: LumiPreamble = activeCombo
    ? { topic: activeCombo.topicRecap, skill: skillBlock }
    : { skill: skillBlock };

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
        lumiSkillTag: activeSkillTag,
        lumiSubject: subject,
        ...(activeTopic ? { lumiTopic: activeTopic } : {}),
        ...(activeCombo ? { lumiComboLabel: activeCombo.label } : {}),
        // Kid-facing recap rendered at the top of the quiz player.
        // Topic recap (combo path only) + skill recap (always).
        // See src/lib/science-skills.ts.
        lumiPreamble,
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
    skillTag: activeSkillTag,
    topic: activeTopic,
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
