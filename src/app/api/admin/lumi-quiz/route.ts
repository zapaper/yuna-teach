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
import { getDeepDivePreamble } from "@/lib/lumi-deepdive";

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
  // Level filter — Lumi quizzes are for the kid's CURRENT level.
  // Without this we pull from any P3–P6 master pool, and a P6 kid ends
  // up with babyish P4 MCQs ("which is not part of the respiratory
  // system?") that don't drill the PSLE-grade skill we're targeting.
  // Source papers store level as "P5" / "Primary 5" / "5" inconsistently
  // — accept all variants. For P6 specifically, also include actual
  // PSLE papers (level="PSLE") since those are the highest-value drill
  // material for the exam Lumi is preparing the kid for.
  const levelVariants = student.level
    ? [
        `P${student.level}`,
        `Primary ${student.level}`,
        String(student.level),
        ...(student.level === 6 ? ["PSLE"] : []),
      ]
    : null;
  const masterPool = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
        ...(levelVariants ? { level: { in: levelVariants } } : {}),
      },
      marksAvailable: { gte: 2 },
      id: { notIn: [...seenIds] },
      // Defensive against blank-stem masters — those render as "Q8:"
      // followed by a blank line and feel broken to the parent, even
      // when self-contained subparts technically fill in the prompt.
      // Catches both NULL stems and empty strings (the column is
      // nullable, so we need the compound NOT).
      AND: [
        { transcribedStem: { not: null } },
        { transcribedStem: { not: "" } },
      ],
      ...(activeTopic
        ? { syllabusTopic: activeTopic }
        : { skillTags: { has: activeSkillTag } }),
    },
    select: {
      id: true,
      questionNum: true,
      examPaperId: true,
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

  // Multi-part siblings: a master like Q19 of a paper can live as TWO
  // rows in the DB (Q19a stem-only with the diagram, Q19bc with the
  // sub-parts and no stem of its own). Picking either row alone gives
  // the kid half a question — empty stem OR missing diagram. Pull
  // every sibling in the same (paperId, baseNum) group as a primary
  // match so the merge step downstream can combine them. Mirrors
  // daily-quiz/route.ts:803-818.
  const baseNum = (n: string) => n.replace(/[a-zA-Z]+$/, "");
  const siblingKeys = new Set(masterPool.map(q => `${q.examPaperId}:${baseNum(q.questionNum)}`));
  const distinctPaperIds = [...new Set(masterPool.map(q => q.examPaperId))];
  const siblingsRaw = distinctPaperIds.length > 0
    ? await prisma.examQuestion.findMany({
        where: { examPaperId: { in: distinctPaperIds }, answer: { not: null } as { not: null } },
        select: {
          id: true,
          questionNum: true,
          examPaperId: true,
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
      })
    : [];
  // Union: keep every primary match plus its siblings (deduped by id).
  // Some siblings only show up in siblingsRaw because they didn't pass
  // the primary filter on their own — e.g. blank-stem Q19bc when its
  // partner Q19a was the topic / skill match.
  const byId = new Map<string, typeof masterPool[number]>();
  for (const q of masterPool) byId.set(q.id, q);
  for (const q of siblingsRaw) {
    if (byId.has(q.id)) continue;
    if (!siblingKeys.has(`${q.examPaperId}:${baseNum(q.questionNum)}`)) continue;
    byId.set(q.id, q);
  }
  const expandedPool = [...byId.values()];

  // Group by (paperId, baseNum). Each group is one logical question.
  type Master = typeof masterPool[number];
  const groupMap = new Map<string, Master[]>();
  for (const q of expandedPool) {
    const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(q);
  }
  for (const g of groupMap.values()) {
    g.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }
  // Drop any group where ANY sibling is in seenIds — re-serving even
  // one part of a question the kid already attempted defeats the dedup
  // intent. (Primary pool's `id: notIn seenIds` only caught the lead.)
  for (const [key, g] of groupMap) {
    if (g.some(m => seenIds.has(m.id))) groupMap.delete(key);
  }
  // Each group's "representative" — the picker selects on group reps;
  // the merge step combines all members at write time. We derive
  // selection-relevant fields from the union (skillTags) or the first
  // sibling that has them (subTopic, syllabusTopic, difficulty).
  type Group = { key: string; rep: Master; members: Master[]; skillTags: string[]; subTopic: string | null; syllabusTopic: string | null; difficulty: number | null };
  const groups: Group[] = [];
  for (const [key, members] of groupMap) {
    const rep = members[0];
    const skillTags = [...new Set(members.flatMap(m => m.skillTags ?? []))];
    const subTopic = members.find(m => m.subTopic)?.subTopic ?? null;
    const syllabusTopic = members.find(m => m.syllabusTopic)?.syllabusTopic ?? null;
    const difficulty = members.find(m => m.difficulty != null)?.difficulty ?? null;
    groups.push({ key, rep, members, skillTags, subTopic, syllabusTopic, difficulty });
  }

  if (groups.length < 3) {
    return NextResponse.json({
      error: "not enough unseen questions",
      detail: activeTopic
        ? `Only ${masterPool.length} unseen masters in topic "${activeTopic}". Kid has likely already attempted most of them.`
        : `Only ${masterPool.length} unseen masters with skillTag="${activeSkillTag}".`,
    }, { status: 404 });
  }

  // Difficulty-shuffle helper: shuffle within each difficulty bucket,
  // then return groups in ascending-difficulty order. Used by every
  // picker path so repeat quizzes don't serve identical sets.
  const orderByDifficulty = (pool: Group[]): Group[] => {
    const buckets = new Map<number, Group[]>();
    for (const g of pool) {
      const d = g.difficulty ?? 3;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d)!.push(g);
    }
    for (const list of buckets.values()) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    const out: Group[] = [];
    for (const d of [...buckets.keys()].sort((a, b) => a - b)) {
      out.push(...buckets.get(d)!);
    }
    return out;
  };

  // Step 3: pick `count` groups from the pool.
  //   · Combo path with sub-topic weights: for each sub-topic in the
  //     weights map, take that many groups, preferring skill-tagged ones.
  //     Fill any shortfall by relaxing the skill preference, then
  //     by pulling from other sub-topics in the same topic.
  //   · Combo path without weights: take `count`, preferring skill-
  //     tagged groups.
  //   · Skill-only path: just difficulty-shuffle and slice.
  const pickedGroups: Group[] = [];
  const pickedKeys = new Set<string>();
  const takeSkillFirst = (pool: Group[], n: number) => {
    const ordered = orderByDifficulty(pool);
    const withSkill = ordered.filter(g => g.skillTags.includes(activeSkillTag));
    const without = ordered.filter(g => !g.skillTags.includes(activeSkillTag));
    const taken: Group[] = [];
    for (const g of [...withSkill, ...without]) {
      if (taken.length >= n) break;
      if (pickedKeys.has(g.key)) continue;
      taken.push(g);
      pickedKeys.add(g.key);
    }
    return taken;
  };

  if (activeSubTopicWeights) {
    for (const [subTopic, weight] of Object.entries(activeSubTopicWeights)) {
      const subPool = groups.filter(g => g.subTopic === subTopic);
      pickedGroups.push(...takeSkillFirst(subPool, weight));
    }
    // Top up the rest from any remaining topic groups, skill-first.
    if (pickedGroups.length < count) {
      const remaining = groups.filter(g => !pickedKeys.has(g.key));
      pickedGroups.push(...takeSkillFirst(remaining, count - pickedGroups.length));
    }
  } else {
    pickedGroups.push(...takeSkillFirst(groups, count));
  }
  // Trim if over.
  pickedGroups.length = Math.min(pickedGroups.length, count);

  // ── Multi-part merge ──────────────────────────────────────────────
  // Each picked group becomes ONE clone via the same merge function the
  // daily-quiz endpoint uses. Without this, a group like Rosyth Q19a
  // (stem + diagram) + Q19bc (sub-parts b/c, no stem of its own) would
  // serve only one row and lose the other half of the question.
  // Copied near-verbatim from src/app/api/daily-quiz/route.ts:1676-1810
  // so both endpoints emit identically-shaped clones.
  function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!answer || !answer.trim()) return result;
    // Accepts "(b)" preceded by start-of-string, "|", "\n", OR ". " /
    // "? " / "! " (sentence end + space). Without the sentence-end
    // case, a master answer formatted as
    //   "(a) wheels reduce friction. (b) gravity acts on the train..."
    // would fail to split because "(b)" is preceded by ". " rather than
    // a newline — and the merge would dump (b) AND (c) text into
    // subpart (a)'s answer field. PSLE 2020 Q37ab hit this; spotted on
    // Kaiyang's Forces quiz cmqrap2g70003eg2krus3gnlu.
    const re = /(^|[|\n]|[.?!]\s)\s*\(?([a-z](?:i{1,4}|iv|v|vi{0,3})?)\)\s*/gi;
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

  type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };
  function mergeOeqGroup(group: Master[]) {
    const first = group[0];
    const leadStem = (first.transcribedStem ?? "").trim();
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      const qStem = (q.transcribedStem ?? "").trim();
      const extraStem = q !== first && qStem && qStem !== leadStem ? qStem : "";
      const processed = realSubs.map((sp, idx) => {
        let next = sp;
        if (idx === 0 && extraStem) {
          next = { ...next, text: `${extraStem}\n\n${sp.text ?? ""}`.trim() };
        }
        if (q !== first && q.diagramImageData && idx === 0 && !next.refImageBase64) {
          const diagramData = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
          next = { ...next, refImageBase64: diagramData };
        }
        return next;
      });
      allSubparts.push(...processed);
    }
    const sentinels: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      sentinels.push(...subs.filter(s => s.label.startsWith("_")));
    }
    const firstStem = (group.find(q => (q.transcribedStem ?? "").trim())?.transcribedStem ?? "").trim();
    const combinedStem = firstStem;
    const diagramImageData = first.diagramImageData
      || group.find(q => q.diagramImageData)?.diagramImageData
      || null;
    const answerParts: string[] = [];
    for (const q of group) {
      const ans = (q.answer ?? "").trim();
      if (!ans) continue;
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      if (realSubs.length === 1) {
        const lbl = realSubs[0].label.toLowerCase();
        if (!ans.toLowerCase().includes(`(${lbl})`)) {
          answerParts.push(`(${lbl}) ${ans}`);
          continue;
        }
      }
      answerParts.push(ans);
    }
    const combinedAnswer = [...new Set(answerParts)].join("\n");
    const seenLabels = new Set<string>();
    const uniqueSubparts: Subpart[] = [];
    for (const sp of allSubparts) {
      const key = sp.label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      uniqueSubparts.push(sp);
    }
    const partAnswers = new Map<string, string>();
    for (const q of group) {
      const parsed = parsePartAnswers(q.answer);
      if (parsed.size > 0) {
        for (const [label, text] of parsed) partAnswers.set(label, text);
        continue;
      }
      const sibSubs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
      if (sibRealSubs.length === 1 && q.answer?.trim()) {
        partAnswers.set(sibRealSubs[0].label.toLowerCase(), q.answer.trim());
      }
    }
    const enrichedSubparts = uniqueSubparts.map(sp => {
      const ans = partAnswers.get(sp.label.toLowerCase());
      return ans !== undefined ? { ...sp, answer: ans } : sp;
    });
    return {
      ...first,
      answer: combinedAnswer || first.answer,
      transcribedStem: combinedStem,
      transcribedSubparts: (enrichedSubparts.length > 0 || sentinels.length > 0)
        ? [...enrichedSubparts, ...sentinels]
        : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData,
    };
  }

  // Merge each picked group into a single clone-shaped record.
  const picked = pickedGroups.map(g => mergeOeqGroup(g.members));

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
  //
  // The TOPIC half prefers Lumi's stored conceptual diagnosis for THIS
  // kid + this topic — pattern-derived watchOuts speak directly to the
  // confusions the workshop already identified, instead of the
  // hand-written generic content on the combo definition. Falls back
  // to the static topicRecap when the kid has no cached patterns for
  // this topic (e.g. P5 kid + a topic the workshop never tagged).
  const skillBlock = SCIENCE_SKILL_PREAMBLE[activeSkillTag];
  let topicBlock = activeCombo?.topicRecap;
  if (activeCombo) {
    const deepDive = getDeepDivePreamble(student.name ?? "", subject as "science", activeCombo.topic);
    if (deepDive) topicBlock = deepDive;
  }
  const lumiPreamble: LumiPreamble = activeCombo
    ? { topic: topicBlock!, skill: skillBlock }
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
