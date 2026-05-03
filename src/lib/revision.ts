import { prisma } from "./db";

// Revise-work analysis. Pull a student's recent completed papers,
// find the questions where marks were lost (full or partial), bucket
// them by subject, and surface a small summary the parent UI can use.

const RECENT_PAPER_LIMIT = 100;

export type SubjectKey = "math" | "science" | "english";

export type SubjectSummary = {
  mistakeCount: number;       // total questions with lost marks
  paperCount: number;         // distinct completed papers contributing
  topTopics: string[];        // up to 4 most-frequent topics with mistakes
  earliestAt: string | null;  // ISO of the oldest contributing paper
};

export type StudentMistakeSummary = {
  studentName: string;
  studentLevel: number | null;
  papersScanned: number;
  bySubject: Record<SubjectKey, SubjectSummary>;
};

function classifySubject(s: string | null | undefined): SubjectKey | null {
  const lower = (s ?? "").toLowerCase();
  if (lower.includes("math")) return "math";
  if (lower.includes("science")) return "science";
  if (lower.includes("english")) return "english";
  return null;
}

// Primary export: per-subject summary used by the modal's initial render.
export async function analyseStudentMistakes(studentId: string): Promise<StudentMistakeSummary> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { name: true, displayName: true, level: true },
  });
  if (!student) throw new Error("student not found");

  // Latest completed papers assigned to the student. We pull paper-
  // level metadata + per-question marking results so we can detect
  // mistakes (marksAwarded < marksAvailable) without a second query.
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: RECENT_PAPER_LIMIT,
    select: {
      id: true,
      subject: true,
      completedAt: true,
      questions: {
        select: {
          id: true,
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
        },
      },
    },
  });

  const init = (): SubjectSummary => ({
    mistakeCount: 0,
    paperCount: 0,
    topTopics: [],
    earliestAt: null,
  });
  const bySubject: Record<SubjectKey, SubjectSummary> = {
    math: init(), science: init(), english: init(),
  };
  // Track topic counts and contributing papers per subject.
  const topicCounts: Record<SubjectKey, Map<string, number>> = {
    math: new Map(), science: new Map(), english: new Map(),
  };
  const contributingPapers: Record<SubjectKey, Set<string>> = {
    math: new Set(), science: new Set(), english: new Set(),
  };

  for (const p of papers) {
    const subj = classifySubject(p.subject);
    if (!subj) continue;
    let paperContributed = false;
    for (const q of p.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null) continue;
      if (q.marksAwarded >= q.marksAvailable) continue;
      bySubject[subj].mistakeCount++;
      paperContributed = true;
      const topic = q.syllabusTopic?.trim();
      if (topic) {
        topicCounts[subj].set(topic, (topicCounts[subj].get(topic) ?? 0) + 1);
      }
    }
    if (paperContributed) {
      contributingPapers[subj].add(p.id);
      const iso = p.completedAt!.toISOString();
      if (!bySubject[subj].earliestAt || iso < bySubject[subj].earliestAt!) {
        bySubject[subj].earliestAt = iso;
      }
    }
  }

  for (const subj of ["math", "science", "english"] as const) {
    bySubject[subj].paperCount = contributingPapers[subj].size;
    bySubject[subj].topTopics = [...topicCounts[subj].entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([topic]) => topic);
  }

  return {
    studentName: student.displayName ?? student.name,
    studentLevel: student.level,
    papersScanned: papers.length,
    bySubject,
  };
}

// Pull mistake question IDs in the order the revision paper should
// present them. Used by the create-paper endpoint, separate from the
// summary path so we don't pay the cost on the first modal render.
export type MistakeQuestion = {
  // Original (master/clone) question id — the source of the mistake.
  sourceQuestionId: string;
  syllabusTopic: string | null;
  isMcq: boolean;
  isCompOeq: boolean;
  // The clone-paper this came from, for ordering by recency.
  cloneCompletedAt: Date;
  // Marking artefacts the review-mode paper needs.
  marksAwarded: number;
  marksAvailable: number;
  studentAnswer: string | null;
  markingNotes: string | null;
};

function isMcqQuestion(opts: unknown, optImgs: unknown, answer: string | null): boolean {
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
  // Numeric-1-to-4 answer is a strong MCQ signal even if options are
  // stored elsewhere.
  const a = (answer ?? "").trim().replace(/[().]/g, "");
  return a === "1" || a === "2" || a === "3" || a === "4";
}

function isCompOeq(topic: string | null): boolean {
  const t = (topic ?? "").toLowerCase();
  return t.includes("comprehension") && (t.includes("open") || t.includes("oeq"));
}

export async function fetchMistakeQuestions(
  studentId: string,
  subject: SubjectKey,
  limit: number,
): Promise<MistakeQuestion[]> {
  // Pull each clone question (with marking artefacts) and the source
  // question it points at. We restrict to the requested subject and to
  // papers the student has actually finished.
  const subjectMatch = subject === "math" ? "math" : subject === "science" ? "science" : "english";
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
      subject: { contains: subjectMatch, mode: "insensitive" },
    },
    orderBy: { completedAt: "desc" },
    take: RECENT_PAPER_LIMIT,
    select: {
      id: true,
      completedAt: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          marksAwarded: true,
          marksAvailable: true,
          studentAnswer: true,
          markingNotes: true,
          syllabusTopic: true,
          sourceQuestionId: true,
          transcribedOptions: true,
          transcribedOptionImages: true,
          answer: true,
        },
      },
    },
  });

  const out: MistakeQuestion[] = [];
  // Dedupe by sourceQuestionId so the parent doesn't see the same
  // mistake twice if the student got it wrong on multiple clones of
  // the same source question. Keep the most-recent clone's marking
  // (it's the freshest signal of what the student actually did).
  const seen = new Set<string>();
  for (const p of papers) {
    for (const q of p.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null) continue;
      if (q.marksAwarded >= q.marksAvailable) continue;
      // sourceQuestionId is null for some legacy / direct-master rows
      // — skip those so the practice paper doesn't try to clone a
      // question that doesn't have a stable source.
      if (!q.sourceQuestionId) continue;
      if (seen.has(q.sourceQuestionId)) continue;
      seen.add(q.sourceQuestionId);
      out.push({
        sourceQuestionId: q.sourceQuestionId,
        syllabusTopic: q.syllabusTopic,
        isMcq: isMcqQuestion(q.transcribedOptions, q.transcribedOptionImages, q.answer),
        isCompOeq: isCompOeq(q.syllabusTopic),
        cloneCompletedAt: p.completedAt!,
        marksAwarded: q.marksAwarded,
        marksAvailable: q.marksAvailable,
        studentAnswer: q.studentAnswer,
        markingNotes: q.markingNotes,
      });
    }
  }

  // Trim to limit, preferring most recent (already most-recent first
  // because the papers query is ordered desc by completedAt).
  return out.slice(0, limit);
}

// Apply per-subject ordering rules:
//   math / science → MCQ first, then OEQ
//   english       → group by syllabusTopic, comp-OEQ topic last
// Within each bucket, keep the input order (= recency).
export function orderMistakesForRevision(
  subject: SubjectKey,
  qs: MistakeQuestion[],
): MistakeQuestion[] {
  if (subject === "math" || subject === "science") {
    const mcq = qs.filter((q) => q.isMcq);
    const oeq = qs.filter((q) => !q.isMcq);
    return [...mcq, ...oeq];
  }
  // English: group by topic, comp-OEQ last.
  const groups = new Map<string, MistakeQuestion[]>();
  const compOeqGroup: MistakeQuestion[] = [];
  for (const q of qs) {
    if (q.isCompOeq) {
      compOeqGroup.push(q);
      continue;
    }
    const key = q.syllabusTopic ?? "(untagged)";
    const arr = groups.get(key);
    if (arr) arr.push(q);
    else groups.set(key, [q]);
  }
  const out: MistakeQuestion[] = [];
  // Iterate insertion order (= recency-by-first-occurrence).
  for (const arr of groups.values()) out.push(...arr);
  out.push(...compOeqGroup);
  return out;
}
