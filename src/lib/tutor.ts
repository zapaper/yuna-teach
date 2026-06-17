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
import MATH_TRAPS_JSON from "@/lib/math-traps.json";

// Math-trap lookup. Tagged offline by scripts/_tag-math-traps.ts —
// one tag per (master or orphan) question id, value is one of the 6
// trap categories or null. Lookup is sourceQuestionId-first so all
// clones of a master inherit the master's tag.
const MATH_TRAPS = MATH_TRAPS_JSON as Record<string, string | null>;

// Display names + short descriptions + advice for the 6 traps.
// The advice references the corresponding master class slugs so the
// parent can jump straight to a teaching slide.
const TRAP_META: Record<string, { name: string; what: string; advice: string }> = {
  "internal-transfer": {
    name: "Internal Transfer (Constant Total)",
    what: "When one person gives some of their amount to another, the TOTAL between the two stays the same.",
    advice: "Mark the question with **TOTAL constant** the moment you see 'X gave to Y'. The trap is treating the total as if it changed. Master class: **Hidden Constant Total — Pattern A**.",
  },
  "equal-removal": {
    name: "Equal Removal (Constant Difference)",
    what: "When the SAME amount is added to or removed from both quantities, the DIFFERENCE stays the same.",
    advice: "Look for 'each spent / each gained' — the gap doesn't move. Master class: **Hidden Constant Total — Pattern B**.",
  },
  "one-unchanged": {
    name: "One Quantity Unchanged",
    what: "Only ONE of the two quantities changed; the other was untouched.",
    advice: "Underline the part that didn't move and treat it as your anchor. Master class: **Hidden Constant Total — Pattern C**.",
  },
  "equalise-ratios": {
    name: "Equalise Ratios",
    what: "Two situations share an EQUAL TOTAL but different ratios — combining ratios directly is wrong.",
    advice: "Scale each ratio to the common total first, THEN compare or combine. Master class: **Hidden Constant Total — Pattern D**.",
  },
  "nested-fractions": {
    name: "Nested Fractions (Remainder of Remainder)",
    what: "A fraction is taken, then another fraction of the REMAINDER. The trap is applying the second fraction to the original whole.",
    advice: "After the first fraction is spent, redraw the bar with what's LEFT as the new whole before taking the second fraction. Master class: **Nested Fractions**.",
  },
  "percentage-traps": {
    name: "Percentage Reference Shift",
    what: "The 'reference whole' for the percentage changes mid-problem — a 20% rise after a 20% drop doesn't return to the start.",
    advice: "Always re-state what each percentage is OF before computing. Master class: **Percentage Traps**.",
  },
};

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
type GeminiReport = {
  patterns: GeminiPattern[];
  classification: GeminiClassification[];
  // Resolution + staleness metadata added by the workshop. Old caches
  // (regenerated before this shipped) won't have these — code falls
  // back to idx-based resolution and skips the staleness check.
  questionIdByIdx?: Record<string, string>;
  generatedAt?: string;
  wrongCounts?: { total: number; oeq: number; mcq: number };
};

// ---- Public TutorData type ----
export type Topline = {
  avgPct: number;
  totalAwarded: number;
  totalAvailable: number;
  paperCount: number;
  strongTopics: Array<{ topic: string; pct: number }>;
  weakTopics: Array<{ topic: string; pct: number; attempts: number }>;
  // Every topic with at least 3 attempts. The share-image chart
  // uses this so the export shows the kid's full topic spread, not
  // just the top-2-strong + top-3-weak subset baked into the two
  // arrays above.
  allTopics: Array<{ topic: string; pct: number; attempts: number }>;
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
  // Actual question number (e.g. "16", "33a") so the parent can find
  // the question on the printed paper. The workshop's questionRef is
  // a workshop idx like "[8]" which is meaningless outside the cache.
  questionNum: string | null;
  questionText: string | null;
  studentAnswer: string | null;
  markingNotes: string | null;
  diagramImageData: string | null;
  // Used by loadTutorData to know which questions actually need a
  // diagram fetched. Always null in the public response — we wipe it
  // before returning to the client so the wire payload stays lean.
  questionId?: string | null;
  isMcq: boolean;
  options: string[];
  picked: string | null;
  correct: string | null;
  // Syllabus topic for this question — used by the runtime to detect
  // when most examples of a pattern come from one topic, so the UI
  // can suggest a focused practice on that topic.
  topic?: string | null;
};
export type MistakeCard = {
  bucket:
    // Science / cross-subject buckets:
    | "final_consequence" | "vague_terminology" | "trend_description" | "missing_context" | "diagram_analysis"
    // English-specific buckets (added so the personalised-quiz puller
    // can pool questions across kids with similar gaps — e.g. all
    // "collocation" examples become one drilling pool):
    | "collocation" | "grammar_signals" | "spelling_slips" | "synthesis_transformation" | "vocab_precision"
    // Fallback when no bucket regex matches:
    | "topical";
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

// Surface drift between the cached diagnosis and current papers so
// the Tutor UI can warn the parent + offer a refresh. `kind` says
// what got out of sync; counts let the UI describe how much.
export type StaleInfo = {
  kind: "fresh" | "stale";
  cachedAt: string | null;
  cachedWrongs: number;
  currentWrongs: number;
};
// Single-step assessment history surfaced to the UI so the LumiSummary
// can say "since last check on X, you've moved past patterns Y, Z" /
// "your average improved by N pp". Computed at runtime by diffing the
// current diagnosis against the previousAssessment snapshot the
// workshop stamped into the cache.
export type PreviousAssessmentDelta = {
  generatedAt: string;             // when the prior assessment ran
  patternsCleared: string[];       // pattern names that dropped out of the top 4
  patternsNew: string[];           // pattern names that appeared this run
  avgDelta: number | null;         // current avg% - prior avg% (positive = improvement)
  paperCountDelta: number | null;  // current paper count - prior paper count
};

export type TutorData =
  | {
      kind: "ineligible";
      reason: string;
      paperCount: number;
      // Populated when the kid has at least one non-revision paper.
      // Lets the UI render the Lumi greeting + topic chart even when
      // we don't yet have enough data for common-mistakes /
      // conceptual-gap diagnosis. Omitted when paperCount is 0.
      childFirst?: string;
      childFullName?: string;
      subject?: string;
      topline?: Topline;
    }
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
      stale: StaleInfo;
      previousAssessment: PreviousAssessmentDelta | null;
    };

// ---- Standard taxonomy ----
type StandardBucket = MistakeCard["bucket"] | ConceptCard["bucket"] | "incomplete_answer" | "topical";

// Patterns that map to one of the two CONCEPT buckets — these are the
// "the kid is confusing two ideas / has the relationship backwards"
// patterns, which power the Conceptual Gaps section + the concept-pair
// quiz. The earlier regex was much narrower (only caught "misinterpret"
// when followed by a specific term like heat/light/biological), which
// meant kids like Jeremiah and Ruthie surfaced 0 conceptual gaps even
// when their diagnosis had patterns like "Reversing Energy Flow" or
// "Misinterpreting Visual Data".
const INVERSE_RE = /\binverse|inverted|reciprocal|opposite\s+relationship|revers(e|ing|al)\b/i;
// Matches words that signal a conceptual confusion. Two recent
// additions worth flagging:
//   • mix[\s-]?up — catches "Mix-Up" (hyphenated, the v4 prompt's
//     preferred form), "Mix Up", "MixUp" and the older "Mixing Up".
//     Without this, all v4 patterns ending in "Mix-Up" silently
//     bucket as common mistakes instead of conceptual gaps.
//   • \bvs\.?\b — pattern names like "Heart vs Lungs", "Volume vs
//     Capacity" are concept-pair confusions by definition.
const CONCEPT_RE = /conflat|confus(e|ing|ion)\b|misattribut|misappl|wrong\s+(process|concept|idea)|misidentif|misjudg|misinterpret|mix(ing|es)?[\s-]?up|mix[\s-]?up|mis-?understand|faulty\s+(logic|reasoning|deduction)|\bvs\.?\b/i;
const INCOMPLETE_RE = /\bblank\s+(answer|submission)|skipping?\s+(sub|initial|or\s+incomplete|open[- ]?ended)|incomplete\s+(or\s+blank|sub|explanation|answer|response)|left\s+blank|skipped\s+sub-?questions?|holding\s+back\s+(on\s+)?(written\s+)?evidence|overly\s+general\s+explanation/i;
const FINAL_RE = /final\s+consequence|stops?\s+short|stopping\s+(one\s+)?step\s+short|stopping\s+at\s+the\s+immediate|connecting\s+(the\s+)?(final\s+)?dot/i;
const VAGUE_RE = /vague\s+(everyday\s+)?language|scientific\s+(term|vocab|keyword)|terminology|precise\s+scientific|imprecise|missing\s+scientific/i;
const TREND_RE = /trend|describe.*data|describe.*graph|data\s+(and\s+)?(trend|graph|diagram)\s+(description|misinterp)/i;
const CONTEXT_RE = /\b(context(ual)?|setup|specific\s+context|ignor(es|ing)\s+.*(key\s+)?(context|data|information|clues?)|missing\s+context|scenario|provided\s+(data|context)|hidden\s+nuance|key\s+question\s+condition|sentence\s+(context|flow|clue)|surrounding\s+context|visual\s+text|small\s+sentence\s+clue|matching\s+(words|details)\s+(to|in)\s+(context|visual))/i;
const DIAGRAM_RE = /\bdiagram(?!.*interpret)|superficial|diagram\s+(misinterp|misanalysis)/i;
// English-specific buckets — see MistakeCard bucket union.
const COLLOCATION_RE = /partnership|partner\s+words?|fixed\s+(word|english\s+)?(pair|phrase)|fixed\s+phrases?|word\s+pair|pairing\s+(words?|prepositions?)|preposition\s+(after|pair|verb)|noticing\s+prepositions/i;
const GRAMMAR_SIGNALS_RE = /grammar\s+(signpost|rule|clue|cue)|hidden\s+grammar|tricky\s+grammar|structural\s+grammar|singular\s+subject|reported\s+speech|word\s+form|qualifier\s+words?|grammar\s+conversion/i;
const SPELLING_RE = /spelling|capitali[sz]ation|caps?\s+(and\s+spelling|slip)|typo|spell\s+by\s+sound|spelling\s+based\s+on\s+sound|mechanics|spell.{0,15}sound|irregular\s+verb/i;
const SYNTHESIS_RE = /synthesis|transformation|complex\s+grammar|advanced\s+grammar|connecting\s+words?|linking\s+ideas?|sentence\s+rewriting/i;
const VOCAB_PRECISION_RE = /unfamiliar\s+vocab|exact\s+vocab(ulary)?\s+fit|precise\s+vocab(ulary)?|vocabulary\s+(precision|fit)|hesitating\s+on\s+(unfamiliar\s+)?vocab/i;

function bucketFor(patternName: string): StandardBucket {
  // Order matters: incomplete and final_consequence are checked first
  // because their phrasing can overlap concept terms (e.g. "skipping
  // explanations" might also contain "confus").
  if (INCOMPLETE_RE.test(patternName)) return "incomplete_answer";
  if (FINAL_RE.test(patternName))      return "final_consequence";
  if (INVERSE_RE.test(patternName))    return "inverse_data";
  if (CONCEPT_RE.test(patternName))    return "concept_confusion";
  if (VAGUE_RE.test(patternName))      return "vague_terminology";
  if (TREND_RE.test(patternName))      return "trend_description";
  // English buckets BEFORE the broad CONTEXT_RE — "Context Clues in
  // Cloze" should bucket as collocation/grammar-signals etc. when it
  // names a more specific shape, but the existing missing_context
  // bucket is fine as a catch-all for "missing context" patterns.
  if (COLLOCATION_RE.test(patternName))       return "collocation";
  if (GRAMMAR_SIGNALS_RE.test(patternName))   return "grammar_signals";
  if (SPELLING_RE.test(patternName))          return "spelling_slips";
  if (SYNTHESIS_RE.test(patternName))         return "synthesis_transformation";
  if (VOCAB_PRECISION_RE.test(patternName))   return "vocab_precision";
  if (CONTEXT_RE.test(patternName))    return "missing_context";
  if (DIAGRAM_RE.test(patternName))    return "diagram_analysis";
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
  questionId: string;
  // sourceQuestionId is the master question this clone descended from.
  // We need it so the math-trap tags (keyed by master) can resolve
  // across all of a master's clones; falling back to questionId for
  // orphan questions that have no source.
  sourceQuestionId: string | null;
  marksLost: number;
  topic: string;
  isMcq: boolean;
  paperTitle: string;
  questionNum: string;
  questionText: string;
  studentAnswer: string;
  correctAnswer: string;
  markingNotes: string;
  options: string[];
};
// Cloze passages stored in transcribedSubparts._passage carry the whole
// multi-paragraph text with 10-15 inline blanks like `**(46)________**`.
// For a single Lumi example we want just the context around THIS
// question's blank — the parent can't be expected to scan a 1500-char
// passage for the one blank Adriel got wrong.
//
// scope:
//   - "sentence": Grammar Cloze / Vocab Cloze — the test is purely
//     within one sentence; expand to ./!/? punctuation.
//   - "paragraph": Comprehension Cloze — the kid needs the
//     surrounding ideas to find the right word; expand to paragraph
//     break (blank line or \n\n).
function sliceClozePassageToContext(
  passage: string,
  blankPosition: number,
  scope: "sentence" | "paragraph",
): { text: string; blankLabel: string | null } {
  if (!passage) return { text: "", blankLabel: null };
  const re = /\(\d+\)/g;
  const matches: Array<{ index: number; length: number; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(passage)) !== null) {
    matches.push({ index: m.index, length: m[0].length, label: m[0] });
  }
  if (matches.length === 0) return { text: passage, blankLabel: null };
  // If the question's blank position is out of range (e.g. the
  // passage's blank count doesn't match the section's question count),
  // fall back to the whole passage so we never hide content.
  if (blankPosition < 0 || blankPosition >= matches.length) return { text: passage, blankLabel: null };
  const blank = matches[blankPosition];

  if (scope === "paragraph") {
    // Paragraphs are separated by a blank line (one or more \n with no
    // word characters between them). Find the nearest blank-line
    // boundary backwards from the blank, and forwards.
    const before = passage.slice(0, blank.index);
    const after = passage.slice(blank.index);
    const startMatch = before.match(/\n\s*\n(?=[\s\S]*$)/g);
    const start = startMatch ? before.lastIndexOf(startMatch[startMatch.length - 1]) + startMatch[startMatch.length - 1].length : 0;
    const endRel = after.search(/\n\s*\n/);
    const end = endRel < 0 ? passage.length : blank.index + endRel;
    const sliced = passage.slice(start, end).trim();
    if (sliced.length < blank.length + 2) return { text: passage, blankLabel: blank.label };
    return { text: sliced, blankLabel: blank.label };
  }

  // sentence scope (default for Grammar / Vocab Cloze)
  const SENTENCE_END = /[.!?。！？\n]/;
  let start = blank.index;
  while (start > 0 && !SENTENCE_END.test(passage[start - 1])) start--;
  while (start < passage.length && /\s/.test(passage[start])) start++;
  let end = blank.index + blank.length;
  while (end < passage.length && !SENTENCE_END.test(passage[end])) end++;
  if (end < passage.length) end++;
  const sliced = passage.slice(start, end).trim();
  if (sliced.length < blank.length + 2) return { text: passage, blankLabel: blank.label };
  return { text: sliced, blankLabel: blank.label };
}

function reconstructWrongs(papers: Array<{
  title: string;
  metadata: unknown;
  subject: string | null;
  questions: Array<{
    id: string;
    questionNum: string;
    sourceQuestionId: string | null;
    studentAnswer: string | null; answer: string | null;
    marksAwarded: number | null; marksAvailable: number | null;
    markingNotes: string | null; transcribedOptions: unknown;
    transcribedStem: string | null; transcribedSubparts: unknown;
    syllabusTopic: string | null;
  }>;
}>): WrongRecord[] {
  const nonRev = papers.filter(p => !((p.metadata as { revisionMode?: unknown } | null)?.revisionMode));
  const wrongs: WrongRecord[] = [];
  let idx = 0;
  for (const p of nonRev) {
    // Section info for cloze passage slicing. paper.metadata.englishSections
    // lists each section's startIndex / endIndex as positions in the
    // p.questions array. We use these to figure out which (N) blank
    // marker inside a cloze section's _passage corresponds to THIS
    // specific question, so we can slice the passage down to just
    // the sentence around that blank instead of dumping the full
    // multi-paragraph cloze passage into every example.
    const englishSections = ((p.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number }> } | null)?.englishSections) ?? [];
    for (let qPos = 0; qPos < p.questions.length; qPos++) {
      const q = p.questions[qPos];
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
      // questions show the full prompt (a)/(b)/(c). Generally drop
      // subparts whose label starts with "_" — those are marker-only
      // context fields (_passage, _passageText) that carry the whole
      // reading passage, and including them blows up Comp-OEQ examples
      // with the entire passage + every numbered question.
      //
      // EXCEPTION: Cloze sections (Grammar Cloze, Comprehension Cloze,
      // Vocab Cloze MCQ) have an EMPTY transcribedStem because the
      // passage itself IS the question — the kid fills in inline (N)
      // blanks. For these we keep the _passage subpart so the parent
      // can actually read the context. The empty-stem heuristic is
      // safe: only Cloze + Editing sections have empty stems, and
      // both want the passage shown.
      const stemRaw = (q.transcribedStem ?? "").trim();
      const stemIsEmpty = stemRaw.length === 0;
      let questionText = stemRaw;
      const sps = q.transcribedSubparts as unknown;
      // Find the cloze blank LABEL for this question (only relevant when
      // we'll be showing the _passage subpart). The question's position
      // within its section maps to the Nth `(<digits>)` marker in the
      // passage — section.startIndex is the array index of the section's
      // first question, so (qPos - section.startIndex) is the 0-indexed
      // blank position.
      const section = englishSections.find(s => qPos >= s.startIndex && qPos <= s.endIndex) ?? null;
      const blankPositionInSection = section ? qPos - section.startIndex : -1;

      if (Array.isArray(sps)) {
        const subpartArr = sps as Array<{ label?: string; text?: string }>;
        const lines: string[] = [];
        for (const sp of subpartArr) {
          if (!sp.label) {
            if (sp.text) lines.push(sp.text.trim());
            continue;
          }
          if (!sp.label.startsWith("_")) {
            const txt = `(${sp.label}) ${sp.text ?? ""}`.trim();
            if (txt) lines.push(txt);
            continue;
          }
          // Stem-less question → keep the _passage so the parent can see
          // the cloze context. Otherwise drop underscore-prefixed marker
          // context (Comp-OEQ _passage etc).
          const isPassageSubpart = sp.label === "_passage" || sp.label === "_passageText";
          if (!(stemIsEmpty && isPassageSubpart)) continue;
          const passageText = sp.text ?? "";
          // Comprehension Cloze needs the whole paragraph for context;
          // Grammar / Vocab Cloze are sentence-bound (the grammatical
          // signal sits inside one sentence).
          const topicLc = (q.syllabusTopic ?? "").toLowerCase();
          const scope: "sentence" | "paragraph" = topicLc.includes("comprehension") && topicLc.includes("cloze")
            ? "paragraph"
            : "sentence";
          let slicedText = passageText;
          let blankLabel: string | null = null;
          if (blankPositionInSection >= 0) {
            const result = sliceClozePassageToContext(passageText, blankPositionInSection, scope);
            slicedText = result.text;
            blankLabel = result.blankLabel;
          }
          // For paragraph-scope (Comprehension Cloze) the paragraph
          // can carry multiple blanks — call out WHICH one this
          // question is so the parent doesn't have to guess.
          if (slicedText) {
            const header = scope === "paragraph" && blankLabel
              ? `**${q.questionNum}**'s blank is **${blankLabel}** below.`
              : "";
            lines.push(header ? `${header}\n\n${slicedText}` : slicedText);
          }
        }
        if (lines.length > 0) questionText = [questionText, lines.join("\n")].filter(Boolean).join("\n\n");
      }
      // Strip the canonical typed-OEQ noise from the student's answer:
      // "Working: …" / "Final answer: …" labels and "(no working shown)"
      // — same cleanup the diagnosis HTML uses.
      //
      // The Working-stripping regex deliberately stops ONLY at an
      // explicit "Final answer:" / "Answer:" delimiter. The earlier
      // version had `|$` in the lookahead which let the strip extend
      // to end-of-string when no Final-answer label existed — that
      // wiped legitimate answer text on kids (e.g. Ruthie) who write
      // "(a) Working: It is waterproof. (b) Working: …" with no
      // Final-answer label, leaving just "(a)" on screen.
      const cleanedAnswer = (q.studentAnswer ?? "")
        .replace(/\bworking\s*:\s*[\s\S]*?(?=\bfinal\s*ans|\bans(?:wer)?\s*:)/gi, "")
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
        questionId: q.id,
        sourceQuestionId: q.sourceQuestionId,
        marksLost: av - aw,
        topic: (q.syllabusTopic ?? "").trim() || "—",
        isMcq,
        paperTitle: p.title,
        questionNum: q.questionNum,
        questionText,
        studentAnswer: cleanedAnswer,
        correctAnswer: (q.answer ?? "").trim(),
        markingNotes: cleanedNotes,
        options: optsArr,
      });
    }
  }
  return wrongs;
}

// Build a partial topline payload for the ineligible state so the UI
// can still render the Lumi greeting + topic chart when there are
// some papers but not enough for full diagnosis. Returns {} when
// the kid has no papers — there's literally nothing to show.
function partialFromTopline(args: {
  studentName: string;
  subject: string;
  topline: ReturnType<typeof computeTopline>;
}): { childFirst?: string; childFullName?: string; subject?: string; topline?: Topline } {
  const { studentName, subject, topline } = args;
  if (topline.paperCount === 0) return {};
  const childFirst = studentName.split(/\s+/)[0] ?? studentName;
  const topics = [...topline.topicTotals.entries()]
    .filter(([, v]) => v.attempts >= 3 && v.available > 0)
    .map(([t, v]) => ({ topic: t, attempts: v.attempts, pct: Math.round((v.awarded / v.available) * 100) }));
  return {
    childFirst,
    childFullName: studentName,
    subject,
    topline: {
      avgPct: topline.avgPct,
      totalAwarded: topline.totalAwarded,
      totalAvailable: topline.totalAvailable,
      paperCount: topline.paperCount,
      strongTopics: [...topics].sort((a, b) => b.pct - a.pct).slice(0, 2).map(t => ({ topic: t.topic, pct: t.pct })),
      weakTopics: [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3),
      allTopics: [...topics].sort((a, b) => b.pct - a.pct),
      nudge: null,
    },
  };
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
    return {
      kind: "ineligible",
      reason: "Need at least 3 papers to surface common mistakes.",
      paperCount: topline.paperCount,
      ...partialFromTopline({ studentName, subject, topline }),
    };
  }

  // Pattern → bucket + marks lost
  const wrongs = reconstructWrongs(papers);
  // Two-way resolution:
  //   1. By questionId (preferred): stable across new papers — a
  //      cached example from June still maps to the same DB question
  //      regardless of how many papers the kid has finished since.
  //   2. By idx (fallback): for caches written before this metadata
  //      shipped. Still works when the paper set hasn't changed.
  const wrongByIdx = new Map(wrongs.map(w => [w.idx, w]));
  const wrongByQuestionId = new Map(wrongs.map(w => [w.questionId, w]));
  const questionIdByIdx = report.questionIdByIdx ?? {};
  type PatternStat = { name: string; bucket: StandardBucket; what: string; advice: string; triggerKeywords: string[]; examples: MistakeExample[]; marksLost: number };
  const refToWrong = (ref: string): WrongRecord | null => {
    const m = /\[(\d+)\]/.exec(ref);
    if (!m) return null;
    const idx = parseInt(m[1], 10);
    const cachedQid = questionIdByIdx[String(idx)];
    // When the workshop stamped questionIdByIdx (every cache written
    // after the stable-id rollout), resolve STRICTLY via questionId.
    // The earlier idx-based fallback caused 1-to-N mismatches: if the
    // student finished a new paper between workshop time and now, the
    // current wrongs array shifts and `wrongByIdx[idx]` points at a
    // DIFFERENT question than the one Gemini analysed — so the
    // example's "whatWentWrong" describes one question while the
    // resolved stem / answer is from another. Better to return null
    // and show the bare workshop sentence than mismatched detail.
    if (cachedQid) {
      return wrongByQuestionId.get(cachedQid) ?? null;
    }
    // Legacy caches without questionIdByIdx fall back to idx ordering.
    return wrongByIdx.get(idx) ?? null;
  };
  const enrichExample = (ex: GeminiExample): MistakeExample => {
    const w = refToWrong(ex.questionRef);
    // Type-mismatch guard — if the cached example says it was an OEQ
    // but the resolved wrong record is an MCQ (or vice versa), the
    // idx mapping has drifted (different paper order, different
    // question order, or the cache predates the current DB state).
    // Returning the bare diagnosis text without misleading question
    // detail is safer than showing the wrong question.
    const typeMatch = !ex.type || !w
      ? true
      : (ex.type === "mcq" ? w.isMcq : !w.isMcq);
    if (!w || !typeMatch) {
      return {
        questionRef: ex.questionRef, whatWentWrong: ex.whatWentWrong,
        paperTitle: null, questionNum: null, questionText: null, studentAnswer: null,
        markingNotes: null, diagramImageData: null, isMcq: false,
        options: [], picked: null, correct: null, topic: null,
      };
    }
    return {
      questionRef: ex.questionRef,
      whatWentWrong: ex.whatWentWrong,
      paperTitle: w.paperTitle.replace(/^\s*\[[A-Z_-]+\]\s*/g, "").replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z)?\)\s*$/g, "").trim(),
      questionNum: w.questionNum,
      questionText: w.questionText,
      studentAnswer: w.studentAnswer,
      markingNotes: w.markingNotes,
      diagramImageData: null,        // filled in by a targeted follow-up query below
      questionId: w.questionId,      // wiped before returning to the client
      isMcq: w.isMcq,
      options: w.options,
      picked: w.isMcq ? w.studentAnswer : null,
      // Surface correctAnswer for BOTH MCQ and typed-cloze examples.
      // The page previously hid the correct answer for non-MCQ rows
      // (set null), leaving the parent reading "Adriel wrote 'used'"
      // with no indication of what the right answer was. Cloze sections
      // store the correct word in q.answer; show it.
      correct: w.correctAnswer || null,
      topic: w.topic || null,
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
    // Same two-step resolution as enrichExample so marks-lost per
    // pattern survives idx drift from new paper completions.
    const cachedQid = questionIdByIdx[String(c.idx)];
    const w = cachedQid ? wrongByQuestionId.get(cachedQid) : wrongByIdx.get(c.idx);
    if (!w) continue;
    patternStats[c.patternIndex].marksLost += w.marksLost;
  }

  const CONCEPT_BUCKETS: Array<ConceptCard["bucket"]> = ["concept_confusion", "inverse_data"];
  // Common Mistakes = anything Gemini surfaced that ISN'T explicitly a
  // concept-confusion or an incomplete-blank pattern. Allowlisting only
  // specific technique buckets (final_consequence / vague_terminology /
  // trend_description / missing_context / diagram_analysis) was too
  // brittle — Gemini frequently named patterns like "Ignores Specific
  // Question Data" or "Missing Scientific Keywords" that fell through
  // to `topical` and were silently dropped, leaving David with one
  // common mistake and Jeremiah/Kaiyang with none. Now `topical`
  // patterns flow through here so they surface at the kid's actual
  // weak spots.
  // Below 15 analysable wrong records, Gemini's patterns are noisy —
  // 3-4 wrong answers can be entirely coincidental, the workshop just
  // hasn't seen enough to call a recurring habit. Mirror the
  // `_find-p6-science-kids.ts` filter (≥15) so Lumi only shows the
  // diagnostic-grade sections (Common Mistakes + Conceptual Gaps) when
  // the underlying data supports them. Below the threshold we still
  // render the bar chart + Topics for Practice (the "what to assign"
  // surface) — the parent still gets actionable advice; we just don't
  // pretend to read fine-grained patterns that aren't there yet.
  const MIN_ANALYSABLE_WRONGS = 15;
  const enoughForPatterns = wrongs.length >= MIN_ANALYSABLE_WRONGS;
  // Show ALL workshop patterns, not just top 2 in each bucket. The
  // workshop prompt already asks for 3-4 patterns total and prefers 3
  // strong over 4 weak, so the upstream cap is the right place to
  // limit. Slicing again at the runtime cut "we have 3 common
  // mistakes" down to 2 and the parent never saw the third.
  const commonMistakes: MistakeCard[] = !enoughForPatterns ? [] : patternStats
    .filter(p => !CONCEPT_BUCKETS.includes(p.bucket as ConceptCard["bucket"]) && p.bucket !== "incomplete_answer")
    .sort((a, b) => b.marksLost - a.marksLost)
    .map(p => ({
      bucket: p.bucket as MistakeCard["bucket"],
      name: p.name,
      what: p.what,
      advice: p.advice,
      triggerKeywords: p.triggerKeywords,
      examples: p.examples,
      marksLost: p.marksLost,
    }));

  const conceptualGaps: ConceptCard[] = !enoughForPatterns ? [] : patternStats
    .filter(p => CONCEPT_BUCKETS.includes(p.bucket as ConceptCard["bucket"]))
    .sort((a, b) => b.marksLost - a.marksLost)
    .map(p => ({
      bucket: p.bucket as ConceptCard["bucket"],
      name: p.name,
      what: p.what,
      advice: p.advice,
      examples: p.examples,
      marksLost: p.marksLost,
    }));

  // Math-trap callouts. Deterministic, classification-grounded:
  // for each math wrong record we already have an offline-tagged trap
  // (one of the 6 master-class categories). Tally marks lost per trap;
  // anything that crosses 1% of the subject's total available marks
  // gets surfaced as its own Common Mistake card. These run
  // independently of the >=15-wrongs Gemini gate — the math-traps
  // lookup is precise enough that even 5 hits on a single trap is
  // worth calling out.
  const isMath = subject.toLowerCase().includes("math");
  const trapCards: MistakeCard[] = [];
  if (isMath && topline.totalAvailable > 0) {
    type TrapAgg = { trap: string; marksLost: number; examples: WrongRecord[] };
    const aggByTrap: Record<string, TrapAgg> = {};
    for (const w of wrongs) {
      const tag = (w.sourceQuestionId && MATH_TRAPS[w.sourceQuestionId])
        || MATH_TRAPS[w.questionId]
        || null;
      if (!tag || !TRAP_META[tag]) continue;
      const a = aggByTrap[tag] ?? { trap: tag, marksLost: 0, examples: [] };
      a.marksLost += w.marksLost;
      if (a.examples.length < 3) a.examples.push(w);
      aggByTrap[tag] = a;
    }
    const minMarks = topline.totalAvailable * 0.01;
    const qualified = Object.values(aggByTrap)
      .filter(a => a.marksLost >= minMarks)
      .sort((a, b) => b.marksLost - a.marksLost);
    for (const q of qualified) {
      const meta = TRAP_META[q.trap];
      trapCards.push({
        bucket: "missing_context",
        name: meta.name,
        what: meta.what,
        advice: meta.advice,
        triggerKeywords: [],
        examples: q.examples.map(w => ({
          questionRef: `[${w.idx}]`,
          whatWentWrong: w.markingNotes || `${childFirst} lost ${w.marksLost} mark${w.marksLost === 1 ? "" : "s"} on this one.`,
          paperTitle: w.paperTitle.replace(/^\s*\[[A-Z_-]+\]\s*/g, "").replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z)?\)\s*$/g, "").trim(),
          questionNum: w.questionNum,
          questionText: w.questionText,
          studentAnswer: w.studentAnswer,
          markingNotes: w.markingNotes,
          diagramImageData: null,
          questionId: w.questionId,
          isMcq: w.isMcq,
          options: w.options,
          picked: w.isMcq ? w.studentAnswer : null,
          correct: w.isMcq ? w.correctAnswer : null,
          topic: w.topic || null,
        })),
        marksLost: Math.round(q.marksLost * 10) / 10,
      });
    }
  }
  // Trap callouts go BEFORE Gemini-detected ones — they're specific
  // and prescriptive (the parent gets a named technique with a master-
  // class pointer), so they read as the most actionable items.
  const allCommonMistakes = [...trapCards, ...commonMistakes];

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

  // Staleness — drift between the cached wrong count and the current
  // one. If the cache predates wrongCounts being stamped we can't
  // tell, so we treat that as "fresh" rather than alarming the
  // parent over a missing field. Threshold: any growth at all flips
  // the flag, because even one new paper means the patterns may be
  // missing examples the parent has just seen.
  const cachedWrongs = report.wrongCounts?.total ?? wrongs.length;
  const currentWrongs = wrongs.length;
  const stale: StaleInfo = {
    kind: report.wrongCounts && currentWrongs > cachedWrongs ? "stale" : "fresh",
    cachedAt: report.generatedAt ?? null,
    cachedWrongs,
    currentWrongs,
  };
  const previousAssessment = buildPreviousAssessmentDelta(report, topline);
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
      // Sort high → low so the share chart reads left-to-right
      // strongest → weakest, matching the on-screen progress chart.
      allTopics: [...topics].sort((a, b) => b.pct - a.pct),
      nudge,
    },
    commonMistakes: allCommonMistakes,
    conceptualGaps,
    topicsForPractice: weakTopics,
    generatedAt: new Date().toISOString(),
    stale,
    previousAssessment,
  };
}

// Diff the previousAssessment snapshot carried in the cache against the
// current run's pattern names + topline. Returns null when there is no
// prior to compare against (first-ever workshop run).
function buildPreviousAssessmentDelta(
  report: { patterns?: Array<{ name: string }>; previousAssessment?: PrevAssessmentCacheShape | null },
  topline: { avgPct: number; paperCount: number },
): PreviousAssessmentDelta | null {
  const prior = report.previousAssessment;
  if (!prior || !prior.generatedAt) return null;
  const currentNames = new Set((report.patterns ?? []).map(p => p.name));
  const priorNames = new Set(prior.patternNames ?? []);
  const patternsCleared = [...priorNames].filter(n => !currentNames.has(n));
  const patternsNew = [...currentNames].filter(n => !priorNames.has(n));
  const priorAvg = prior.toplineSnapshot?.avgPct ?? null;
  const priorPapers = prior.toplineSnapshot?.paperCount ?? null;
  return {
    generatedAt: prior.generatedAt,
    patternsCleared,
    patternsNew,
    avgDelta: priorAvg !== null ? topline.avgPct - priorAvg : null,
    paperCountDelta: priorPapers !== null ? topline.paperCount - priorPapers : null,
  };
}

// Mirrors the shape the workshop writes into the cache (see
// _workshop-unified.ts PreviousAssessment). Local to tutor.ts since
// nothing else consumes the cache directly.
type PrevAssessmentCacheShape = {
  generatedAt: string;
  patternNames: string[];
  wrongCounts?: { total: number; oeq: number; mcq: number } | null;
  toplineSnapshot?: { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number } | null;
};

function subjectMatches(rawSubject: string | null, target: string): boolean {
  const t = (rawSubject ?? "").toLowerCase();
  const tgt = target.toLowerCase();
  if (tgt === "science") return t.includes("science");
  if (tgt === "math") return t.includes("math");
  if (tgt === "english") return t.includes("english");
  if (tgt === "chinese") return t.includes("chinese") || (rawSubject ?? "").includes("华文") || (rawSubject ?? "").includes("中文");
  return false;
}

// Demo-video override: viewing Student666's Lumi pulls David lim's
// papers + cache so the demo has rich content under an anonymous
// account. The display name STAYS as Student666 — only the
// underlying data source swaps. Keep this list tightly scoped; this
// is for marketing demos only. sourceFirstName is the literal name
// the workshop wrote into the cache text ("Adriel sometimes…");
// post-shape we replace every occurrence with the display student's
// first name so the demo doesn't leak the original kid.
type DemoRedirectSource = { sourceStudentId: string; sourceSafeName: string; sourceFirstName: string };
type DemoRedirect = DemoRedirectSource & {
  // Optional per-subject overrides. When the requested subject matches
  // (lowercased), the override's source is used instead of the
  // default. Useful for demo accounts that should pull from different
  // kids per subject — e.g. student67 wants David Lim's data for most
  // subjects but Ruthie's for Science because Ruthie's Science Lumi
  // reads better for the recording.
  bySubject?: Record<string, DemoRedirectSource>;
};

export const DEMO_DATA_REDIRECT: Record<string, DemoRedirect> = {
  // Student666 → David lim
  "cmnsa6bww006bgmuwflevt143": { sourceStudentId: "cmm5wf91d000ryrxwaddlo6xh", sourceSafeName: "david-lim", sourceFirstName: "David" },
  // student67 → David lim by default; Science → Ruthie because her
  // v3 Science Lumi reads cleanly for demo recording.
  "cmqg8upha0000l3ijfr3co6t8": {
    sourceStudentId: "cmm5wf91d000ryrxwaddlo6xh",
    sourceSafeName: "david-lim",
    sourceFirstName: "David",
    bySubject: {
      science: { sourceStudentId: "cmos5pfmw000114n1eem2gcw7", sourceSafeName: "ruthie", sourceFirstName: "Ruthie" },
    },
  },
};

// Walk every string field on the TutorData "ready" branch and apply
// the given replace. Used by the demo redirect to swap the source
// kid's name out of cached pattern text + examples.
function replaceStringsInTutorData<T>(data: T, replace: (s: string) => string): T {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") return replace(data) as unknown as T;
  if (Array.isArray(data)) return (data.map(v => replaceStringsInTutorData(v, replace)) as unknown) as T;
  if (typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = replaceStringsInTutorData(v, replace);
    }
    return out as T;
  }
  return data;
}

export async function loadTutorData(studentId: string, subject: string): Promise<TutorData> {
  const displayStudent = await prisma.user.findUnique({
    where: { id: studentId },
    select: { name: true },
  });
  if (!displayStudent) return { kind: "ineligible", reason: "Student not found", paperCount: 0 };

  // Apply demo redirect: data fetched from sourceStudent, but the
  // display name stays as the requested student. Per-subject overrides
  // take precedence — e.g. student67's Science routes to Ruthie even
  // though the default points at David Lim.
  const baseRedirect = DEMO_DATA_REDIRECT[studentId] ?? null;
  const subjectOverride = baseRedirect?.bySubject?.[subject.toLowerCase()] ?? null;
  const redirect = subjectOverride
    ? { sourceStudentId: subjectOverride.sourceStudentId, sourceSafeName: subjectOverride.sourceSafeName, sourceFirstName: subjectOverride.sourceFirstName }
    : baseRedirect;
  const dataStudentId = redirect?.sourceStudentId ?? studentId;
  const cacheSafe = redirect?.sourceSafeName ?? safeName(displayStudent.name);

  // CRITICAL: keep diagramImageData OUT of this bulk select. It's a
  // base64 JPEG per question; Mark has 36 papers × ~12 questions of
  // these, which used to pull megabytes over the wire on every fresh
  // Tutor load. Diagrams are fetched in a targeted second query after
  // we know which 3-4 example questions per card we'll actually show.
  //
  // Two-pass column hydrate (mirrors daily-quiz's lean-pool pattern —
  // see project_neon_egress_costs memory): the FIRST pull is light —
  // just the scoring columns the topline + eligibility check need.
  // The heavy text columns (transcribedStem / transcribedOptions /
  // transcribedSubparts / markingNotes / answer / sourceQuestionId)
  // only flow over the wire when a cached Gemini diagnosis exists and
  // we actually need to feed reconstructWrongs. Uncached kids (now
  // surfaced in the admin dropdown by the ≥15-wrongs path) and
  // ineligible kids (< 3 papers) skip the heavy pull entirely.
  const papersLight = await prisma.examPaper.findMany({
    where: { assignedToId: dataStudentId, markingStatus: { in: ["complete", "released"] } },
    select: {
      id: true, title: true, subject: true, metadata: true,
      questions: {
        select: {
          id: true, marksAwarded: true, marksAvailable: true,
          studentAnswer: true, syllabusTopic: true,
        },
        // Deterministic question order — without this Prisma can
        // shuffle nested includes by physical row position, which
        // silently drifts the wrongs idx between the workshop run
        // and the page reconstruction.
        orderBy: { orderIndex: "asc" },
      },
    },
    // CRITICAL: match the workshop's wrongs index ordering. The
    // cached classification array references idx values assigned in
    // this order. Mismatched ordering = mis-attributed marks lost
    // per pattern.
    orderBy: { completedAt: "desc" },
  });
  const subjectPapersLight = papersLight.filter(p => subjectMatches(p.subject, subject));

  // Find the cached Gemini diagnosis for this kid + subject. cacheSafe
  // honours the demo redirect so e.g. Student666 loads David lim's
  // bundled diagnosis.
  const cacheKey = `${cacheSafe}:${subject.toLowerCase()}`;
  const cachedReport = TUTOR_CACHE[cacheKey];
  if (!cachedReport) {
    // No diagnosis yet — empty common mistakes / conceptual gaps,
    // but still show the topline + topics for practice. NO heavy
    // pull needed: topline only reads marksAwarded/Available/topic
    // which the light query already has.
    const topline = computeTopline(subjectPapersLight);
    if (topline.paperCount < 3) {
      return {
        kind: "ineligible",
        reason: "Need at least 3 papers to surface common mistakes.",
        paperCount: topline.paperCount,
        ...partialFromTopline({ studentName: displayStudent.name, subject, topline }),
      };
    }
    const childFirst = displayStudent.name.split(/\s+/)[0] ?? displayStudent.name;
    const topics = [...topline.topicTotals.entries()]
      .filter(([, v]) => v.attempts >= 3 && v.available > 0)
      .map(([t, v]) => ({ topic: t, attempts: v.attempts, pct: Math.round((v.awarded / v.available) * 100) }));
    return {
      kind: "ready",
      childFirst,
      childFullName: displayStudent.name,
      subject,
      topline: {
        avgPct: topline.avgPct,
        totalAwarded: topline.totalAwarded,
        totalAvailable: topline.totalAvailable,
        paperCount: topline.paperCount,
        strongTopics: [...topics].sort((a, b) => b.pct - a.pct).slice(0, 2).map(t => ({ topic: t.topic, pct: t.pct })),
        weakTopics: [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3),
        allTopics: [...topics].sort((a, b) => b.pct - a.pct),
        nudge: null,
      },
      commonMistakes: [],
      conceptualGaps: [],
      topicsForPractice: [...topics].sort((a, b) => a.pct - b.pct).slice(0, 3),
      generatedAt: new Date().toISOString(),
      // No cached diagnosis at all → the empty mistakes/concepts are
      // already a stronger signal than a stale flag; treat as fresh.
      stale: { kind: "fresh", cachedAt: null, cachedWrongs: 0, currentWrongs: 0 },
      previousAssessment: null,
    };
  }
  // Heavy second pull: only the subject papers we already filtered, and
  // only when there's a cached diagnosis to feed. Preserves the same
  // orderBy contract (completedAt desc + questions by orderIndex asc)
  // so reconstructWrongs's idx values line up with the workshop's.
  const subjectPaperIds = subjectPapersLight.map(p => p.id);
  const subjectPapers = subjectPaperIds.length > 0 ? await prisma.examPaper.findMany({
    where: { id: { in: subjectPaperIds } },
    select: {
      title: true, metadata: true, subject: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          sourceQuestionId: true,
          studentAnswer: true, answer: true,
          marksAwarded: true, marksAvailable: true,
          markingNotes: true, syllabusTopic: true,
          transcribedOptions: true, transcribedStem: true,
          transcribedSubparts: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: { completedAt: "desc" },
  }) : [];

  const shaped = shapeTutorData({ studentName: displayStudent.name, subject, papers: subjectPapers, report: cachedReport as GeminiReport });
  if (shaped.kind !== "ready") return shaped;

  // Targeted diagram fetch — collect the questionIds we'll actually
  // show (3 examples × 2 mistake cards + 3 × 2 concept cards = ~12
  // max) and hydrate just those. Then wipe the temporary questionId
  // field so it doesn't leak in the wire payload.
  const exampleIds = new Set<string>();
  const allExamples = [
    ...shaped.commonMistakes.flatMap(c => c.examples),
    ...shaped.conceptualGaps.flatMap(c => c.examples),
  ];
  for (const ex of allExamples) if (ex.questionId) exampleIds.add(ex.questionId);
  if (exampleIds.size > 0) {
    const diagrams = await prisma.examQuestion.findMany({
      where: { id: { in: [...exampleIds] } },
      select: { id: true, diagramImageData: true },
    });
    const diagramById = new Map(diagrams.map(d => [d.id, d.diagramImageData]));
    for (const ex of allExamples) {
      if (ex.questionId) ex.diagramImageData = diagramById.get(ex.questionId) ?? null;
    }
  }
  for (const ex of allExamples) ex.questionId = null;

  // Demo redirect post-process: the cache text was written for the
  // source kid ("David sometimes overlooks…"). Swap David → display
  // student's first name AND the possessive form so the rendered
  // diagnosis reads as Student666's. \b ensures we don't catch
  // longer words that contain "David" as a substring.
  if (redirect) {
    const displayFirst = displayStudent.name.split(/\s+/)[0] ?? displayStudent.name;
    const srcRe = new RegExp(`\\b${redirect.sourceFirstName}\\b`, "g");
    return replaceStringsInTutorData(shaped, s => s.replace(srcRe, displayFirst));
  }
  return shaped;
}
