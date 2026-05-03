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
  // Revision papers are filtered out in JS — Prisma's JSON-path NOT
  // would also drop every row with null metadata. See the longer
  // comment in fetchMistakeQuestions.
  const rawPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: RECENT_PAPER_LIMIT * 2,
    select: {
      id: true,
      subject: true,
      completedAt: true,
      metadata: true,
      questions: {
        select: {
          id: true,
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
          sourceQuestionId: true,
        },
      },
    },
  });

  // Filter out revision papers (synthetic mash-ups of past mistakes).
  const papers = rawPapers.filter((p) => {
    const meta = p.metadata as { revisionMode?: string } | null;
    return meta?.revisionMode !== "review" && meta?.revisionMode !== "practice";
  }).slice(0, RECENT_PAPER_LIMIT);

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
  // Dedupe by sourceQuestionId so the summary count matches what
  // fetchMistakeQuestions / orderMistakesForRevision will actually
  // produce on compile. Without dedupe the summary said e.g.
  // 'science: 56 mistakes' but the compiled review only had 13
  // distinct questions because the same source had been answered
  // wrong on multiple clones.
  const seenSourceIds: Record<SubjectKey, Set<string>> = {
    math: new Set(), science: new Set(), english: new Set(),
  };

  for (const p of papers) {
    const subj = classifySubject(p.subject);
    if (!subj) continue;
    let paperContributed = false;
    for (const q of p.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null) continue;
      if (q.marksAwarded >= q.marksAvailable) continue;
      // Skip questions without a sourceQuestionId — fetchMistakes
      // also skips them (can't clone a question with no stable
      // source), so excluding them from the count keeps both paths
      // honest.
      if (!q.sourceQuestionId) continue;
      if (seenSourceIds[subj].has(q.sourceQuestionId)) continue;
      seenSourceIds[subj].add(q.sourceQuestionId);
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
//
// We carry the CLONE's content (the question the student actually
// saw, with its clean transcribed text) rather than re-resolving via
// the source — the clone is what was answered and graded, and copying
// from the source can lose populated fields (e.g. transcribedStem set
// on the clone from a clean-extract pass after the master was
// uploaded).
export type EnglishSectionInfo = {
  label: string;
  passage?: string;
};

export type MistakeQuestion = {
  // Source-question pointer for traceability — what master question
  // this mistake came from. Stored on the new revision paper as
  // sourceQuestionId so cross-paper links survive.
  sourceQuestionId: string;
  // The clone paper + clone question this came from. Needed so the
  // revision paper can copy the student's actual canvas image
  // (which lives under submissions/<cloneExamPaperId>/page_N.jpg)
  // into its own submissions directory.
  cloneQuestionId: string;
  cloneExamPaperId: string;
  // Position of this question within the source clone. Used to keep
  // companions (right-answered passage neighbours) and mistakes in
  // passage-marker order when a revision-paper section is rendered.
  sourceOrderIndex: number;
  syllabusTopic: string | null;
  isMcq: boolean;
  isCompOeq: boolean;
  cloneCompletedAt: Date;
  // Marking artefacts the review-mode paper needs. marksAwarded
  // is nullable because passage-companion questions may include
  // skipped neighbours (null marks) that we still need to fill
  // their passage marker slot.
  marksAwarded: number | null;
  marksAvailable: number;
  studentAnswer: string | null;
  markingNotes: string | null;
  // Question content as the student saw it. transcribedStem can be
  // null for raw exam-paper-uploaded questions; in that case the
  // review page falls back to imageData.
  imageData: string | null;
  answer: string | null;
  answerImageData: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedOptionImages: unknown;
  transcribedSubparts: unknown;
  diagramImageData: string | null;
  diagramBounds: unknown;
  // For English questions: the passage + section label this question
  // sat under in the source clone. Used by the revision-paper
  // builder to reconstruct englishSections in the new paper's
  // metadata so the review UI can render the cloze passage above
  // its blanks (and Comp OEQ above its prompts).
  // sourceSectionKey groups questions that came from the same
  // section of the same source clone — they share a passage and
  // should sit in one section of the revision paper.
  englishSection?: EnglishSectionInfo;
  sourceSectionKey?: string;
  // Companion questions are right-answered passage neighbours we
  // pull in alongside the mistakes so the cloze renderer can fill
  // every blank (mistakes in red, companions in green). They count
  // for rendering only — not for the slider count.
  isCompanion?: boolean;
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
  // papers the student has actually finished. Revision papers are
  // filtered out below in JS — Prisma's JSON-path filter excludes
  // every row where metadata is null, even with NOT, so we can't
  // express "metadata.revisionMode is unset OR not 'review'/'practice'"
  // at the SQL layer without losing every real clone.
  //
  // Why the exclusion matters: revision papers are synthetic
  // mash-ups of past mistakes — counting them would (a) double-count
  // whatever mistakes are in them, and (b) feed fetchPassageCompanions
  // a fake "section" that has no real passage neighbours, leaving
  // cloze blanks unfilled and misaligning the renderer.
  const subjectMatch = subject === "math" ? "math" : subject === "science" ? "science" : "english";
  // Pull a generous extra slice (×2) so even after JS-filtering
  // out revision papers we still hit RECENT_PAPER_LIMIT real clones.
  const rawPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
      subject: { contains: subjectMatch, mode: "insensitive" },
    },
    orderBy: { completedAt: "desc" },
    take: RECENT_PAPER_LIMIT * 2,
    select: {
      id: true,
      completedAt: true,
      // englishSections lives in metadata. We pull it for English
      // queries so the per-mistake englishSection field can be
      // populated and the revision paper can reconstruct cloze /
      // comp-oeq passages.
      metadata: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          orderIndex: true,
          marksAwarded: true,
          marksAvailable: true,
          studentAnswer: true,
          markingNotes: true,
          syllabusTopic: true,
          sourceQuestionId: true,
          // Pull the full content the student saw — this gets copied
          // straight onto the revision paper so the review render
          // matches the original quiz/practice render.
          imageData: true,
          answer: true,
          answerImageData: true,
          transcribedStem: true,
          transcribedOptions: true,
          transcribedOptionImages: true,
          transcribedSubparts: true,
          diagramImageData: true,
          diagramBounds: true,
        },
      },
    },
  });

  // JS-side revision-paper filter (see comment on rawPapers above).
  const papers = rawPapers.filter((p) => {
    const meta = p.metadata as { revisionMode?: string } | null;
    return meta?.revisionMode !== "review" && meta?.revisionMode !== "practice";
  }).slice(0, RECENT_PAPER_LIMIT);

  const out: MistakeQuestion[] = [];
  // Dedupe by sourceQuestionId so the parent doesn't see the same
  // mistake twice if the student got it wrong on multiple clones of
  // the same source question. Keep the most-recent clone's marking
  // (it's the freshest signal of what the student actually did).
  const seen = new Set<string>();
  for (const p of papers) {
    // For English, pre-extract the clone's englishSections so we can
    // attach a passage to each mistake question.
    type RawSection = { label: string; startIndex: number; endIndex: number; passage?: string };
    const englishSections: RawSection[] = subject === "english"
      ? ((p.metadata as { englishSections?: RawSection[] } | null)?.englishSections ?? [])
      : [];
    for (const q of p.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null) continue;
      if (q.marksAwarded >= q.marksAvailable) continue;
      // sourceQuestionId is null for some legacy / direct-master rows
      // — skip those so the practice paper doesn't try to clone a
      // question that doesn't have a stable source.
      if (!q.sourceQuestionId) continue;
      if (seen.has(q.sourceQuestionId)) continue;
      seen.add(q.sourceQuestionId);

      // Match this question to its source-clone englishSection (if
      // any) using its orderIndex against the section's
      // [startIndex, endIndex] range. The same orderIndex space is
      // what the source clone used at quiz-creation time.
      let englishSection: EnglishSectionInfo | undefined;
      let sourceSectionKey: string | undefined;
      if (englishSections.length > 0) {
        const idx = q.orderIndex;
        const sectionPos = englishSections.findIndex(s => idx >= s.startIndex && idx <= s.endIndex);
        if (sectionPos >= 0) {
          const sec = englishSections[sectionPos];
          englishSection = { label: sec.label, ...(sec.passage ? { passage: sec.passage } : {}) };
          // Group key: same source clone + same section index = one
          // section in the new revision paper. Different clones
          // even with the same label get separate sections (their
          // passages differ).
          sourceSectionKey = `${p.id}::${sectionPos}`;
        }
      }

      out.push({
        sourceQuestionId: q.sourceQuestionId,
        cloneQuestionId: q.id,
        cloneExamPaperId: p.id,
        sourceOrderIndex: q.orderIndex,
        syllabusTopic: q.syllabusTopic,
        isMcq: isMcqQuestion(q.transcribedOptions, q.transcribedOptionImages, q.answer),
        isCompOeq: isCompOeq(q.syllabusTopic),
        cloneCompletedAt: p.completedAt!,
        marksAwarded: q.marksAwarded,
        marksAvailable: q.marksAvailable,
        studentAnswer: q.studentAnswer,
        markingNotes: q.markingNotes,
        imageData: q.imageData,
        answer: q.answer,
        answerImageData: q.answerImageData,
        transcribedStem: q.transcribedStem,
        transcribedOptions: q.transcribedOptions,
        transcribedOptionImages: q.transcribedOptionImages,
        transcribedSubparts: q.transcribedSubparts,
        diagramImageData: q.diagramImageData,
        diagramBounds: q.diagramBounds,
        englishSection,
        sourceSectionKey,
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
  // English: group by sourceSectionKey when available so questions
  // from the same source clone-section stay together (they share a
  // passage). Comp-OEQ groups go last. Sections without a source key
  // fall back to syllabusTopic grouping. Within each group sort by
  // sourceOrderIndex so passage markers (1), (2), (3)… line up with
  // the question rows the renderer maps to them.
  const groups = new Map<string, MistakeQuestion[]>();
  const compOeqGroups = new Map<string, MistakeQuestion[]>();
  for (const q of qs) {
    const key = q.sourceSectionKey ?? `topic::${q.syllabusTopic ?? "(untagged)"}`;
    const target = q.isCompOeq ? compOeqGroups : groups;
    const arr = target.get(key);
    if (arr) arr.push(q);
    else target.set(key, [q]);
  }
  const sortBySrc = (arr: MistakeQuestion[]) =>
    arr.sort((a, b) => a.sourceOrderIndex - b.sourceOrderIndex);
  const out: MistakeQuestion[] = [];
  for (const arr of groups.values()) out.push(...sortBySrc(arr));
  for (const arr of compOeqGroups.values()) out.push(...sortBySrc(arr));
  return out;
}

// For each English passage section already represented in `chosen`,
// pull in the right-answered neighbour questions so the cloze
// renderer can paint every blank — mistakes in red, companions in
// green using the student's own (correct) answer. Without these the
// review fills the green-blank slots with whichever wrong answer
// happens to be next in the section, because the renderer uses
// position-based marker→question mapping.
//
// Companions only ride along — the slider's `count` controls how
// many MISTAKES the parent wants. The total question count on the
// resulting paper is mistakes + companions.
export async function fetchPassageCompanions(
  chosen: MistakeQuestion[],
): Promise<MistakeQuestion[]> {
  // Group chosen mistakes by source-clone-section. Only sections
  // that have a passage attached benefit from the companion fill;
  // non-passage sections render question-by-question so right
  // answers from elsewhere in the paper would just be noise.
  type SectionKeyInfo = {
    cloneId: string;
    sectionPos: number;
    knownIds: Set<string>;
    sample: MistakeQuestion;
  };
  const bySection = new Map<string, SectionKeyInfo>();
  for (const q of chosen) {
    if (!q.sourceSectionKey || !q.englishSection?.passage) continue;
    const [cloneId, sectionPosStr] = q.sourceSectionKey.split("::");
    const sectionPos = parseInt(sectionPosStr, 10);
    if (Number.isNaN(sectionPos)) continue;
    let info = bySection.get(q.sourceSectionKey);
    if (!info) {
      info = { cloneId, sectionPos, knownIds: new Set(), sample: q };
      bySection.set(q.sourceSectionKey, info);
    }
    info.knownIds.add(q.cloneQuestionId);
  }
  if (bySection.size === 0) return [];

  // Pull each implicated source clone with its full question list +
  // englishSections metadata so we can pick the [start..end] range
  // of each section.
  const cloneIds = [...new Set([...bySection.values()].map((s) => s.cloneId))];
  const clones = await prisma.examPaper.findMany({
    where: { id: { in: cloneIds } },
    select: {
      id: true,
      completedAt: true,
      metadata: true,
      questions: {
        select: {
          id: true,
          orderIndex: true,
          marksAwarded: true,
          marksAvailable: true,
          studentAnswer: true,
          markingNotes: true,
          syllabusTopic: true,
          sourceQuestionId: true,
          imageData: true,
          answer: true,
          answerImageData: true,
          transcribedStem: true,
          transcribedOptions: true,
          transcribedOptionImages: true,
          transcribedSubparts: true,
          diagramImageData: true,
          diagramBounds: true,
        },
      },
    },
  });

  type RawSection = { label: string; startIndex: number; endIndex: number; passage?: string };
  const out: MistakeQuestion[] = [];
  for (const info of bySection.values()) {
    const clone = clones.find((c) => c.id === info.cloneId);
    if (!clone) continue;
    const englishSections: RawSection[] =
      ((clone.metadata as { englishSections?: RawSection[] } | null)?.englishSections ?? []);
    const sec = englishSections[info.sectionPos];
    if (!sec) continue;

    for (const q of clone.questions) {
      // Companion = any question in the same source-clone-section
      // that isn't already in `chosen` (the mistakes the parent
      // picked). We deliberately include partial-marks and skipped
      // questions too: cloze passages render position-based, so if
      // a section has 5 markers and we only put 4 questions in
      // (because Q3 was skipped), markers shift and answers
      // misalign. Including every neighbour keeps the positions
      // honest — the renderer paints green/red from the actual
      // marksAwarded value. Skip only on missing sourceQuestionId
      // (the create path needs a stable pointer).
      if (q.orderIndex < sec.startIndex || q.orderIndex > sec.endIndex) continue;
      if (info.knownIds.has(q.id)) continue;
      if (!q.sourceQuestionId) continue;

      out.push({
        sourceQuestionId: q.sourceQuestionId,
        cloneQuestionId: q.id,
        cloneExamPaperId: clone.id,
        sourceOrderIndex: q.orderIndex,
        syllabusTopic: q.syllabusTopic,
        isMcq: isMcqQuestion(q.transcribedOptions, q.transcribedOptionImages, q.answer),
        isCompOeq: isCompOeq(q.syllabusTopic),
        cloneCompletedAt: clone.completedAt!,
        marksAwarded: q.marksAwarded,
        // Default missing marksAvailable to 1 — without it the
        // route's totalMarks reduce treats it as 0 and the
        // section-header chip shows "0/N" wrong.
        marksAvailable: q.marksAvailable ?? 1,
        studentAnswer: q.studentAnswer,
        markingNotes: q.markingNotes,
        imageData: q.imageData,
        answer: q.answer,
        answerImageData: q.answerImageData,
        transcribedStem: q.transcribedStem,
        transcribedOptions: q.transcribedOptions,
        transcribedOptionImages: q.transcribedOptionImages,
        transcribedSubparts: q.transcribedSubparts,
        diagramImageData: q.diagramImageData,
        diagramBounds: q.diagramBounds,
        englishSection: { label: sec.label, ...(sec.passage ? { passage: sec.passage } : {}) },
        sourceSectionKey: `${clone.id}::${info.sectionPos}`,
        isCompanion: true,
      });
    }
  }
  return out;
}
