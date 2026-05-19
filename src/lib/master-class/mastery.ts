// Per-student mastery state for a Master Class.
//
// State model (per sub-topic):
//   "untested" — student's most recent mastery quiz on this slug
//                contained no questions for this sub-topic.
//   "mastered" — most recent quiz had ≥1 question for this sub-topic
//                and the student got FULL marks on all of them.
//   "weak"     — most recent quiz had ≥1 question for this sub-topic
//                and the student got partial / 0 marks on at least one.
//
// "Most recent" means the most recent COMPLETED (marked) mastery
// quiz for the (student, slug) pair.

import { prisma } from "@/lib/db";
import { getMasterClass, type MasterClassContent } from "@/data/master-class";

export type SubTopicState = "untested" | "mastered" | "weak";

export type SubTopicMastery = {
  id: string;
  label: string;
  state: SubTopicState;
  // For "weak" — fraction of marks scored on this sub-topic in the
  // most recent attempt, used to rank "weakest 3" for focused quiz.
  scorePct?: number;
};

export type MasteryReport = {
  slug: string;
  totalAttempts: number;       // count of completed mastery quizzes
  latestAttemptAt: Date | null;
  latestAttemptScorePct: number | null;
  subTopics: SubTopicMastery[];
  weakSubTopicIds: string[];   // ranked weakest-first, max 3
  // True if any review paper should be (re)scheduled. The slide-page
  // loader uses this to (re)create a pending review for +7 days.
  hasAnyWrongQuestions: boolean;
};

export async function getMasteryReport(
  slug: string,
  studentId: string,
): Promise<MasteryReport> {
  const content = getMasterClass(slug);
  const subTopics = content?.subTopics ?? [];

  // Most recent completed mastery quiz for (student, slug).
  const latestPaper = await prisma.examPaper.findFirst({
    where: {
      assignedToId: studentId,
      paperType: "mastery",
      completedAt: { not: null },
      metadata: { path: ["masterClassSlug"], equals: slug } as never,
    },
    orderBy: { completedAt: "desc" },
    select: {
      id: true, completedAt: true, score: true,
      questions: {
        select: {
          subTopic: true,
          marksAwarded: true,
          marksAvailable: true,
        },
      },
    },
  });

  const totalAttempts = await prisma.examPaper.count({
    where: {
      assignedToId: studentId,
      paperType: "mastery",
      completedAt: { not: null },
      metadata: { path: ["masterClassSlug"], equals: slug } as never,
    },
  });

  // Quick check: are there ANY wrong questions across ALL completed
  // attempts? Used to decide whether to schedule an auto-review.
  const wrongAggCount = await prisma.examQuestion.count({
    where: {
      examPaper: {
        assignedToId: studentId,
        paperType: "mastery",
        completedAt: { not: null },
        metadata: { path: ["masterClassSlug"], equals: slug } as never,
      },
      // got less than full marks
      AND: [
        { marksAvailable: { gt: 0 } },
        { marksAwarded: { lt: prisma.examQuestion.fields.marksAvailable } },
      ],
    },
  });

  const report: MasteryReport = {
    slug,
    totalAttempts,
    latestAttemptAt: latestPaper?.completedAt ?? null,
    latestAttemptScorePct: latestPaper?.score ?? null,
    subTopics: subTopics.map(st => ({ id: st.id, label: st.label, state: "untested" as SubTopicState })),
    weakSubTopicIds: [],
    hasAnyWrongQuestions: wrongAggCount > 0,
  };

  if (!latestPaper) return report;

  // Group questions of the latest attempt by sub-topic and compute
  // marks awarded vs available.
  const tally = new Map<string, { awarded: number; available: number }>();
  for (const q of latestPaper.questions) {
    if (!q.subTopic) continue;
    if (q.marksAvailable == null || q.marksAwarded == null) continue;
    const cur = tally.get(q.subTopic) ?? { awarded: 0, available: 0 };
    cur.awarded += q.marksAwarded;
    cur.available += q.marksAvailable;
    tally.set(q.subTopic, cur);
  }

  // Assign state to each sub-topic.
  for (const st of report.subTopics) {
    const t = tally.get(st.id);
    if (!t || t.available === 0) continue;
    const pct = t.awarded / t.available;
    if (pct >= 0.9999) {
      st.state = "mastered";
    } else {
      st.state = "weak";
      st.scorePct = pct;
    }
  }

  // Rank weakest first (lowest scorePct), cap at 3 for the focused
  // quiz button.
  report.weakSubTopicIds = report.subTopics
    .filter(st => st.state === "weak")
    .sort((a, b) => (a.scorePct ?? 0) - (b.scorePct ?? 0))
    .slice(0, 3)
    .map(st => st.id);

  return report;
}

// Look up all unique source-question IDs the student got wrong on
// past mastery quizzes for this slug. Used to build the auto-review
// paper. Returns sourceQuestionIds (so we can re-clone them as fresh
// questions on a new paper, the same way mastery quizzes do).
export async function getWrongSourceQuestionIds(
  slug: string,
  studentId: string,
): Promise<string[]> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: studentId,
        paperType: "mastery",
        completedAt: { not: null },
        metadata: { path: ["masterClassSlug"], equals: slug } as never,
      },
      AND: [
        { marksAvailable: { gt: 0 } },
        { marksAwarded: { lt: prisma.examQuestion.fields.marksAvailable } },
      ],
      sourceQuestionId: { not: null },
    },
    select: { sourceQuestionId: true, examPaper: { select: { completedAt: true } } },
    orderBy: { examPaper: { completedAt: "desc" } },
  });
  // Dedupe, preserving most-recent-first order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!r.sourceQuestionId || seen.has(r.sourceQuestionId)) continue;
    seen.add(r.sourceQuestionId);
    out.push(r.sourceQuestionId);
  }
  return out;
}

// Aggregate one report per master-class slug for the list page.
// Lightweight version of getMasteryReport that only returns the
// per-sub-topic states (skips weakSubTopicIds + counts).
export async function getMasteryListView(
  studentId: string,
  contents: MasterClassContent[],
): Promise<Record<string, SubTopicMastery[]>> {
  const out: Record<string, SubTopicMastery[]> = {};
  await Promise.all(contents.map(async c => {
    const r = await getMasteryReport(c.slug, studentId);
    out[c.slug] = r.subTopics;
  }));
  return out;
}
