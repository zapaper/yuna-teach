// Tutor data loader.
//
// Pure server function that produces the data the Tutor page renders.
// Reads from data/tutor-cache/*.gemini-cache.json (workshop snapshots
// of the unified diagnosis runs) and joins with live progress data
// for the topline. Caches per (student, subject) on
// student.settings.tutorCache[subject] with 24h freshness — mirrors
// the AI insights once-a-day cadence the parent already experiences.
//
// Output is the SHAPE the page renders, not raw Gemini output:
//   - topline (avg %, paper count, top strong + weak topics, optional
//     "don't give up" nudge)
//   - up to 2 "common mistakes" (technique-based patterns)
//   - up to 2 "conceptual gaps" (concept_confusion / inverse_data)
//   - topical practice recommendations (from progress data)
//
// Buckets we DROP entirely:
//   - incomplete_answer → becomes the "don't give up" nudge
//   - topical (unbucketed) → folded into Topics for Practice

import { prisma } from "@/lib/db";
import { TUTOR_CACHE } from "@/lib/tutor-cache";

// ---- Gemini cache shape ----
type GeminiExample = {
  questionRef: string;
  type?: "oeq" | "mcq";
  whatWentWrong: string;
};
type GeminiPattern = {
  name: string;
  what: string;
  specific_examples: GeminiExample[];
  strategic_advice: string;
  trigger_keywords: string[];
};
type GeminiClassification = { idx: number; patternIndex: number };
type GeminiReport = { patterns: GeminiPattern[]; classification: GeminiClassification[] };

// ---- Public TutorData type ----
export type Topline = {
  avgPct: number;
  totalAwarded: number;
  totalAvailable: number;
  paperCount: number;
  strongTopics: Array<{ topic: string; pct: number }>;
  weakTopics: Array<{ topic: string; pct: number; attempts: number }>;
  nudge: string | null;  // e.g. "Mark sometimes leaves the last sub-question blank…"
};
export type MistakeExample = {
  questionRef: string;
  whatWentWrong: string;
  // Rich example data (recycled from the diagnosis workshop HTML).
  // When present, the detail panel can render an expandable card
  // with the full question, the student's answer, and the marker
  // notes the kid missed.
  paperTitle: string | null;
  questionText: string | null;
  studentAnswer: string | null;
  markingNotes: string | null;
  diagramImageData: string | null;
  isMcq: boolean;
  options: string[];
  picked: string | null;
  correct: string | null;
};
export type MistakeCard = {
  bucket: "final_consequence" | "vague_terminology" | "trend_description" | "missing_context" | "diagram_analysis";
  name: string;
  what: string;
  advice: string;
  triggerKeywords: string[];
  examples: MistakeExample[];
  marksLost: number;
};
export type ConceptCard = {
  bucket: "concept_confusion" | "inverse_data";
  name: string;
  what: string;
  advice: string;
  examples: MistakeExample[];
  marksLost: number;
};
export type TopicCard = { topic: string; pct: number; attempts: number };

export type TutorData =
  | { kind: "ineligible"; reason: string; paperCount: number }
  | {
      kind: "ready";
      childFirst: string;
      childFullName: string;
      subject: string;
      topline: Topline;
      commonMistakes: MistakeCard[];
      conceptualGaps: ConceptCard[];
      topicsForPractice: TopicCard[];
      generatedAt: string;
    };

// ---- Standard taxonomy ----
type StandardBucket = MistakeCard["bucket"] | ConceptCard["bucket"] | "incomplete_answer" | "topical";

const BUCKET_RULES: Array<{ bucket: StandardBucket; re: RegExp }> = [
  { bucket: "final_consequence",  re: /final\s+consequence|stops?\s+short|stopping\s+(one\s+)?step\s+short/i },
  { bucket: "vague_terminology",  re: /vague\s+(everyday\s+)?language|scientific\s+(term|vocab)|terminology|precise\s+scientific|imprecise/i },
  { bucket: "trend_description",  re: /trend|describe.*data|describe.*graph|data\s+(and\s+)?(trend|graph|diagram)\s+(description|misinterp)/i },
  { bucket: "inverse_data",       re: /inverse|inverted|reciprocal|opposite\s+relationship/i },
  { bucket: "missing_context",    re: /\b(context|setup|specific\s+context|ignoring\s+(key\s+)?context|missing\s+context|scenario|provided\s+data)/i },
  { bucket: "concept_confusion",  re: /conflat|confus(e|ing|ion)\s+|misattribut|misappl|wrong\s+process|misidentif|misjudg|misinterpret(ing)?\s+(heat|light|forces|energy|biological)/i },
  { bucket: "incomplete_answer",  re: /blank|skipping?\s+(sub|initial)|incomplete\s+(or\s+blank|sub|explanation|answer)|leaving|left\s+blank/i },
  { bucket: "diagram_analysis",   re: /diagram(?!.*interpret)|superficial|diagram\s+(misinterp|misanalysis)/i },
];
function bucketFor(patternName: string): StandardBucket {
  for (const r of BUCKET_RULES) if (r.re.test(patternName)) return r.bucket;
  return "topical";
}

// ---- Filename normalisation ----
function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ---- Topline computation (mirrors progress page) ----
// /api/student-progress + page.tsx use:
//   - exclude revision papers
//   - exclude __SKIPPED__ questions
//   - topic ≥ 3 attempts filter
//   - sum awarded/available over surviving topics → subject avg
function computeTopline(
  papers: Array<{
    metadata: unknown;
    subject: string | null;
    questions: Array<{
      marksAwarded: number | null; marksAvailable: number | null;
      studentAnswer: string | null; syllabusTopic: string | null;
    }>;
  }>,
): { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number; topicTotals: Map<string, { attempts: number; awarded: number; available: number }> } {
  const MIN_QS = 3;
  const nonRev = papers.filter(p => !((p.metadata as { revisionMode?: unknown } | null)?.revisionMode));
  const topicTotals = new Map<string, { attempts: number; awarded: number; available: number }>();
  for (const p of nonRev) {
    for (const q of p.questions) {
      const av = q.marksAvailable ?? 0;
      if (av <= 0) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const t = (q.syllabusTopic ?? "").trim();
      if (!t || t === "Untagged") continue;
      const cur = topicTotals.get(t) ?? { attempts: 0, awarded: 0, available: 0 };
      cur.attempts++;
      cur.awarded += q.marksAwarded ?? 0;
      cur.available += av;
      topicTotals.set(t, cur);
    }
  }
  let totalAwarded = 0;
  let totalAvailable = 0;
  for (const t of topicTotals.values()) {
    if (t.attempts < MIN_QS) continue;
    totalAwarded += t.awarded;
    totalAvailable += t.available;
  }
  return {
    avgPct: totalAvailable > 0 ? Math.round((totalAwarded / totalAvailable) * 100) : 0,
    totalAwarded, totalAvailable,
    paperCount: nonRev.length,
    topicTotals,
  };
}

// ---- Marks lost per pattern from cache + wrongs reconstruction ----
// We need to mirror the workshop's wrongs index → classification.idx
// linkage so we know which kid wrongs contributed to which bucket.
const mcqMarkerShape = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
type WrongRecord = {
  idx: number;
  marksLost: number;
  topic: string;
  isMcq: boolean;
  paperTitle: string;
  questionText: string;
  studentAnswer: string;
  correctAnswer: string;
  markingNotes: string;
  diagramImageData: string | null;
  options: string[];
};
function reconstructWrongs(papers: Array<{
  title: string;
  metadata: unknown;
  subject: string | null;
  questions: Array<{
    studentAnswer: string | null; answer: string | null;
    marksAwarded: number | null; marksAvailable: number | null;
    markingNotes: string | null; transcribedOptions: unknown;
    transcribedStem: string | null; transcribedSubparts: unknown;
    diagramImageData: string | null;
    syllabusTopic: string | null;
  }>;
}>): WrongRecord[] {
  const nonRev = papers.filter(p => !((p.metadata as { revisionMode?: unknown } | null)?.revisionMode));
  const wrongs: WrongRecord[] = [];
  let idx = 0;
  for (const p of nonRev) {
    for (const q of p.questions) {
      const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
      if (av === 0 || aw >= av) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const opts = q.transcribedOptions as unknown;
      const optsArr: string[] = Array.isArray(opts)
        ? (opts as unknown[]).map(o => typeof o === "string" ? o : (o as { text?: string })?.text ?? "").filter(Boolean)
        : [];
      const isMcq = optsArr.length >= 2 || mcqMarkerShape.test(q.markingNotes ?? "");
      if (!isMcq && (!q.markingNotes || q.markingNotes.trim().length < 10)) continue;
      idx++;
      // Strip the canonical "Detected: …|" marker-note prefix that
      // repeats the student answer — the workshop did this too.
      let cleanedNotes = (q.markingNotes ?? "").trim();
      const pipeIdx = cleanedNotes.search(/\s*\|\s*/);
      if (pipeIdx >= 0 && /detected\s*:/i.test(cleanedNotes.slice(0, pipeIdx))) {
        cleanedNotes = cleanedNotes.slice(pipeIdx).replace(/^\s*\|\s*/, "");
      }
      cleanedNotes = cleanedNotes.replace(/^detected\s*:\s*[^.\n]*\.?\s*/i, "").trim();
      // Stitch the transcribedStem with the subparts so multi-part
      // questions show the full prompt (a)/(b)/(c).
      let questionText = (q.transcribedStem ?? "").trim();
      const sps = q.transcribedSubparts as unknown;
      if (Array.isArray(sps)) {
        const lines = (sps as Array<{ label?: string; text?: string }>)
          .map(sp => `${sp.label ? `(${sp.label}) ` : ""}${sp.text ?? ""}`.trim())
          .filter(Boolean);
        if (lines.length > 0) questionText = [questionText, lines.join("\n")].filter(Boolean).join("\n\n");
      }
      // Strip the canonical typed-OEQ noise from the student's answer:
      // "Working: …" / "Final answer: …" labels and "(no working shown)"
      // — same cleanup the diagnosis HTML uses.
      const cleanedAnswer = (q.studentAnswer ?? "")
        .replace(/\bworking\s*:\s*[\s\S]*?(?=\bfinal\s*ans|\bans(?:wer)?\s*:|$)/gi, "")
        .replace(/\bfinal\s*ans(?:wer)?\s*:\s*/gi, "")
        .replace(/^ans(?:wer)?\s*:\s*/gi, "")
        .replace(/\(\s*no\s+working\s+(shown|done|written)?\s*\)/gi, "")
        .replace(/\bno\s+working\s+(shown|done|written)\b/gi, "")
        .replace(/\(\s*working\s+shown\s+above\s*\)/gi, "")
        .replace(/^detected\s*:\s*[^.\n]*\.?\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      wrongs.push({
        idx,
        marksLost: av - aw,
        topic: (q.syllabusTopic ?? "").trim() || "—",
        isMcq,
        paperTitle: p.title,
        questionText,
        studentAnswer: cleanedAnswer,
        correctAnswer: (q.answer ?? "").trim(),
        markingNotes: cleanedNotes,
        diagramImageData: q.diagramImageData ?? null,
        options: optsArr,
      });
    }
  }
  return wrongs;
}

// Build the structured TutorData from a (student, subject, cached report).
function shapeTutorData(args: {
  studentName: string;
  subject: string;
  papers: Parameters<typeof reconstructWrongs>[0];
  report: GeminiReport;
}): TutorData {
  const { studentName, subject, papers, report } = args;
  const childFirst = studentName.split(/\s+/)[0] ?? studentName;
  const topline = computeTopline(papers as Parameters<typeof computeTopline>[0]);
  if (topline.paperCount < 3) {
    return { kind: "ineligible", reason: "Need at least 3 papers to surface common mistakes.", paperCount: topline.paperCount };
  }

  // Pattern → bucket + marks lost
  const wrongs = reconstructWrongs(papers);
  // wrongs-by-idx lets us join Gemini's "[49]" example refs to the
  // actual DB question + answer.
  const wrongByIdx = new Map(wrongs.map(w => [w.idx, w]));
  type PatternStat = { name: string; bucket: StandardBucket; what: string; advice: string; triggerKeywords: string[]; examples: MistakeExample[]; marksLost: number };
  const refToWrong = (ref: string): WrongRecord | null => {
    const m = /\[(\d+)\]/.exec(ref);
    if (!m) return null;
    return wrongByIdx.get(parseInt(m[1], 10)) ?? null;
  };
  const enrichExample = (ex: GeminiExample): MistakeExample => {
    const w = refToWrong(ex.questionRef);
    if (!w) {
      return {
        questionRef: ex.questionRef, whatWentWrong: ex.whatWentWrong,
        paperTitle: null, questionText: null, studentAnswer: null,
        markingNotes: null, diagramImageData: null, isMcq: false,
        options: [], picked: null, correct: null,
      };
    }
    return {
      questionRef: ex.questionRef,
      whatWentWrong: ex.whatWentWrong,
      paperTitle: w.paperTitle.replace(/^\s*\[[A-Z_-]+\]\s*/g, "").replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z)?\)\s*$/g, "").trim(),
      questionText: w.questionText,
      studentAnswer: w.studentAnswer,
      markingNotes: w.markingNotes,
      diagramImageData: w.diagramImageData,
      isMcq: w.isMcq,
      options: w.options,
      picked: w.isMcq ? w.studentAnswer : null,
      correct: w.isMcq ? w.correctAnswer : null,
    };
  };
  const patternStats: PatternStat[] = report.patterns.map(p => ({
    name: p.name,
    bucket: bucketFor(p.name),
    what: p.what,
    advice: p.strategic_advice,
    triggerKeywords: p.trigger_keywords ?? [],
    examples: (p.specific_examples ?? []).map(enrichExample),
    marksLost: 0,
  }));
  for (const c of report.classification) {
    if (c.patternIndex < 0 || c.patternIndex >= patternStats.length) continue;
    const w = wrongByIdx.get(c.idx);
    if (!w) continue;
    patternStats[c.patternIndex].marksLost += w.marksLost;
  }

  const TECHNIQUE_BUCKETS: Array<MistakeCard["bucket"]> = ["final_consequence", "vague_terminology", "trend_description", "missing_context", "diagram_analysis"];
  const CONCEPT_BUCKETS: Array<ConceptCard["bucket"]> = ["concept_confusion", "inverse_data"];

  const commonMistakes: MistakeCard[] = patternStats
    .filter(p => TECHNIQUE_BUCKETS.includes(p.bucket as MistakeCard["bucket"]))
    .sort((a, b) => b.marksLost - a.marksLost)
    .slice(0, 2)
    .map(p => ({
      bucket: p.bucket as MistakeCard["bucket"],
      name: p.name,
      what: p.what,
      advice: p.advice,
      triggerKeywords: p.triggerKeywords,
      examples: p.examples,
      marksLost: p.marksLost,
    }));

  const conceptualGaps: ConceptCard[] = patternStats
    .filter(p => CONCEPT_BUCKETS.includes(p.bucket as ConceptCard["bucket"]))
    .sort((a, b) => b.marksLost - a.marksLost)
    .slice(0, 2)
    .map(p => ({
      bucket: p.bucket as ConceptCard["bucket"],
      name: p.name,
      what: p.what,
      advice: p.advice,
      examples: p.examples,
      marksLost: p.marksLost,
    }));

  // Nudge — if incomplete_answer pattern surfaced strongly
  const incompletePattern = patternStats.find(p => p.bucket === "incomplete_answer" && p.marksLost > 0);
  const nudge = incompletePattern
    ? `${childFirst} sometimes leaves sub-questions blank or doesn't push the answer to the final outcome. Don't give up — even a partial answer earns more than blank.`
    : null;

  // Strong + weak topics — from topline topicTotals
  const topics = [...topline.topicTotals.entries()]
    .filter(([, v]) => v.attempts >= 3 && v.available > 0)
    .map(([t, v]) => ({ topic: t, attempts: v.attempts, pct: Math.round((v.awarded / v.available) * 100) }));
  const strongTopics = [...topics].sort((a, b) => b.pct - a.pct).slice(0, 2);
  const weakTopics = [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3);

  return {
    kind: "ready",
    childFirst,
    childFullName: studentName,
    subject,
    topline: {
      avgPct: topline.avgPct,
      totalAwarded: topline.totalAwarded,
      totalAvailable: topline.totalAvailable,
      paperCount: topline.paperCount,
      strongTopics: strongTopics.map(t => ({ topic: t.topic, pct: t.pct })),
      weakTopics,
      nudge,
    },
    commonMistakes,
    conceptualGaps,
    topicsForPractice: weakTopics,
    generatedAt: new Date().toISOString(),
  };
}

function subjectMatches(rawSubject: string | null, target: string): boolean {
  const t = (rawSubject ?? "").toLowerCase();
  const tgt = target.toLowerCase();
  if (tgt === "science") return t.includes("science");
  if (tgt === "math") return t.includes("math");
  if (tgt === "english") return t.includes("english");
  if (tgt === "chinese") return t.includes("chinese") || (rawSubject ?? "").includes("华文") || (rawSubject ?? "").includes("中文");
  return false;
}

export async function loadTutorData(studentId: string, subject: string): Promise<TutorData> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { name: true },
  });
  if (!student) return { kind: "ineligible", reason: "Student not found", paperCount: 0 };

  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: studentId, markingStatus: { in: ["complete", "released"] } },
    select: {
      title: true, metadata: true, subject: true,
      questions: {
        select: {
          studentAnswer: true, answer: true,
          marksAwarded: true, marksAvailable: true,
          markingNotes: true, syllabusTopic: true,
          transcribedOptions: true, transcribedStem: true,
          transcribedSubparts: true,
          diagramImageData: true,
        },
      },
    },
    // CRITICAL: match the workshop's wrongs index ordering. The
    // cached classification array references idx values assigned in
    // this order. Mismatched ordering = mis-attributed marks lost
    // per pattern.
    orderBy: { completedAt: "desc" },
  });
  const subjectPapers = papers.filter(p => subjectMatches(p.subject, subject));

  // Find the cached Gemini diagnosis for this kid + subject.
  const safe = safeName(student.name);
  const cacheKey = `${safe}:${subject.toLowerCase()}`;
  const cachedReport = TUTOR_CACHE[cacheKey];
  if (!cachedReport) {
    // No diagnosis yet — empty common mistakes / conceptual gaps,
    // but still show the topline + topics for practice.
    const topline = computeTopline(subjectPapers);
    if (topline.paperCount < 3) {
      return { kind: "ineligible", reason: "Need at least 3 papers to surface common mistakes.", paperCount: topline.paperCount };
    }
    const childFirst = student.name.split(/\s+/)[0] ?? student.name;
    const topics = [...topline.topicTotals.entries()]
      .filter(([, v]) => v.attempts >= 3 && v.available > 0)
      .map(([t, v]) => ({ topic: t, attempts: v.attempts, pct: Math.round((v.awarded / v.available) * 100) }));
    return {
      kind: "ready",
      childFirst,
      childFullName: student.name,
      subject,
      topline: {
        avgPct: topline.avgPct,
        totalAwarded: topline.totalAwarded,
        totalAvailable: topline.totalAvailable,
        paperCount: topline.paperCount,
        strongTopics: [...topics].sort((a, b) => b.pct - a.pct).slice(0, 2).map(t => ({ topic: t.topic, pct: t.pct })),
        weakTopics: [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3),
        nudge: null,
      },
      commonMistakes: [],
      conceptualGaps: [],
      topicsForPractice: [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3),
      generatedAt: new Date().toISOString(),
    };
  }
  return shapeTutorData({ studentName: student.name, subject, papers: subjectPapers, report: cachedReport as GeminiReport });
}
