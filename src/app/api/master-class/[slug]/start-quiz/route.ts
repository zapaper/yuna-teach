import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { getMasterClassHydrated } from "@/lib/master-class/hydrate";
import { classifyPatternQuestion } from "@/lib/master-class/classify-pattern";
import { classifyCircuitsQuestion } from "@/lib/master-class/classify-circuits";
import { classifyHiddenConstantTotal } from "@/lib/master-class/classify-hidden-constant-total";
import { classifyGeometryMastery } from "@/lib/master-class/classify-geometry-mastery";

// Per-slug stem classifier. When the source question has no
// subTopic tag, we fill it in at clone time so per-sub-topic
// mastery tracking still works.
const STEM_CLASSIFIERS: Record<string, (stem: string | null) => string | null> = {
  "patterns": classifyPatternQuestion,
  "electrical-circuits": classifyCircuitsQuestion,
  "math-hidden-constant-total": classifyHiddenConstantTotal,
  "math-geometry-mastery": classifyGeometryMastery,
};
import { getWrongSourceQuestionIds } from "@/lib/master-class/mastery";

// POST /api/master-class/[slug]/start-quiz
//   body: { studentId: string, parentMasteryId?: string }
//
// Spawns a Mastery quiz for the given student. Pulls 10 MCQ + 6 OEQ
// across the Master Class's sub-topics, with the constraint that
// EACH sub-topic must be represented by at least one OEQ. MCQ slots
// are distributed across sub-topics roughly evenly.
//
// Creates a new ExamPaper with paperType="mastery" and metadata
//   { masterClassSlug, parentMasteryId? }
// Returns { paperId } — the caller navigates to /quiz/<paperId>.

/** MCQ = question has any of: 4-option text array, 4-option image
 *  array, or a 4-row option table. Matches the focused-test detector
 *  so the quiz UI's MCQ/OEQ classification agrees with ours. */
function hasOptions(q: {
  transcribedOptions?: unknown;
  transcribedOptionImages?: unknown;
  transcribedOptionTable?: unknown;
}): boolean {
  const opts = q.transcribedOptions;
  const imgs = q.transcribedOptionImages;
  const tbl = q.transcribedOptionTable;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  if (tbl && typeof tbl === "object" && Array.isArray((tbl as { rows?: unknown }).rows) && (tbl as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

const QUIZ_MCQ_COUNT = 10;
const QUIZ_OEQ_COUNT = 6;

// ─── Multi-part OEQ sibling helpers ──────────────────────────────────
// Mirrors the focused-test / daily-quiz pickers. A source question
// stored as "Q14c" represents only the (c) sub-part; without pulling
// its siblings (Q14a/Q14b) it would render in a practice with only
// the (c) stem and no parent scenario.
function baseNum(questionNum: string) {
  return questionNum.replace(/[a-zA-Z]+$/, "");
}

function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!answer || !answer.trim()) return result;
  // Accept single-letter labels (a, b, c) AND roman-nested labels like
  // (ai), (aii), (bii), (civ). Matches lib/marking.ts.
  const re = /(^|[|\n])\s*\(?([a-z](?:i{1,4}|iv|v|vi{0,3})?)\)\s*/gi;
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

type OeqLike = {
  id: string;
  questionNum: string;
  examPaperId: string;
  transcribedStem: string | null;
  transcribedSubparts: unknown;
  answer: string | null;
  marksAvailable: number | null;
  diagramImageData: string | null;
  imageData: string | null;
  answerImageData: string | null;
};

function mergeOeqGroup<T extends OeqLike>(group: T[]): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Out = any;
  type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };
  const first = group[0];
  // group[0]'s stem is the main stem; later siblings' stems carry extra
  // scenario context that belongs to their own subparts (prepended below).
  const leadStem = (first.transcribedStem ?? "").trim();
  const mainDiagram = first.diagramImageData ?? null;
  const imageSource = (first.imageData && first.imageData.length > 100)
    ? first
    : (group.find(q => q.imageData && q.imageData.length > 100) ?? first);
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
  const sentinels = group.flatMap(q => ((q.transcribedSubparts as Subpart[] | null) ?? []).filter(s => s.label.startsWith("_")));
  const partAnswers = new Map<string, string>();
  for (const q of group) {
    const parsed = parsePartAnswers(q.answer);
    if (parsed.size > 0) {
      for (const [label, text] of parsed) partAnswers.set(label, text);
      continue;
    }
    // No (a)/(b) markers — if this sibling has exactly one real subpart, use its label
    const sibSubs = (q.transcribedSubparts as Subpart[] | null) ?? [];
    const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
    if (sibRealSubs.length === 1 && q.answer?.trim()) {
      partAnswers.set(sibRealSubs[0].label.toLowerCase(), q.answer.trim());
    }
  }
  const enrichedSubparts = allSubparts.map(sp => {
    const ans = partAnswers.get(sp.label.toLowerCase());
    return ans !== undefined ? { ...sp, answer: ans } : sp;
  });
  const rebuiltAnswer = partAnswers.size > 0
    ? [...partAnswers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `(${k}) ${v}`).join(" | ")
    : [...new Set(group.map(q => q.answer).filter(Boolean))].join("\n");
  const sortedGroup = [...group].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  const answerImageData = sortedGroup.find(q => q.answerImageData)?.answerImageData ?? first.answerImageData ?? null;
  const out: Out = {
    ...first,
    imageData: imageSource.imageData,
    answer: rebuiltAnswer || first.answer,
    answerImageData,
    transcribedStem: leadStem,
    transcribedSubparts: enrichedSubparts.length > 0 ? [...enrichedSubparts, ...sentinels] : null,
    marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
    diagramImageData: mainDiagram,
  };
  return out;
}

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await context.params;
  const content = await getMasterClassHydrated(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });
  const subTopics = content.subTopics ?? [];
  // Sub-topics only required for non-regex, non-general-pool classes
  // (the per-sub-topic round-robin picker uses them). Regex-mode AND
  // general-pool classes do a single-pool pick instead.
  if (!content.practiceStemRegex && !content.noSubTopicFilter && subTopics.length === 0) {
    return NextResponse.json({ error: "Master Class has no sub-topics defined" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as {
    studentId?: string;
    parentMasteryId?: string;
    // Optional: when set, the picker pulls 2 MCQ + 1-2 OEQ from EACH
    // of the listed sub-topics (instead of doing the all-sub-topics
    // round-robin). Used by the "Focus on weak topics" button.
    focusSubTopics?: string[];
  };
  const studentId = body.studentId;
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });
  const focusSubTopics = Array.isArray(body.focusSubTopics) ? body.focusSubTopics : [];

  // Auth: session user must be either an admin OR linked-as-parent
  // to the student. Mirrors the daily-quiz flow.
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  const isAdminUser = (me?.name?.toLowerCase() === "admin")
    || (((me?.settings as { admin?: unknown } | null)?.admin) === true);
  if (!isAdminUser && sessionUserId !== studentId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: sessionUserId, studentId } },
    });
    if (!link) return NextResponse.json({ error: "Not linked to student" }, { status: 403 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { level: true },
  });

  // ─── Pull candidate questions ──────────────────────────────────────
  // Three paths:
  //   1. useRegex (Patterns) — stem regex match across subject pool.
  //   2. useClassifier (Circuits) — match by syllabusTopic, but drop
  //      the `subTopic: not null` filter because source questions
  //      don't carry the master-class sub-topic IDs; we'll set those
  //      at clone time via the stem classifier.
  //   3. Default (Interactions) — match by syllabusTopic AND require
  //      an admin-tagged subTopic on each candidate.
  const useRegex = !!content.practiceStemRegex;
  const useClassifier = !useRegex && !!STEM_CLASSIFIERS[slug];
  const useGeneralPool = !useRegex && !useClassifier && !!content.noSubTopicFilter;
  // Multi-topic match — if `topicLabelExtras` is set, the syllabusTopic
  // filter accepts any of [topicLabel, ...extras] (case-insensitive).
  // Used by Chinese Sentence Completion which spans "语文应用 MCQ"
  // (Q9-Q12) and "完成对话" (Q26-Q29) in the bank.
  const allTopicLabels = [content.topicLabel, ...(content.topicLabelExtras ?? [])];
  const syllabusTopicClause = allTopicLabels.length === 1
    ? { syllabusTopic: { equals: content.topicLabel, mode: "insensitive" as const } }
    : { syllabusTopic: { in: allTopicLabels, mode: "insensitive" as const } };
  // Optional paperLevels filter — expanded into the level/title variants
  // we actually see in the bank. PSLE matches level === "PSLE" OR a
  // title containing "PSLE"; P3-P6 match the level field with the
  // common formatting variants. Empty / undefined paperLevels = no
  // level filter (all master papers).
  const paperLevelClause = (() => {
    const levels = content.paperLevels ?? [];
    if (levels.length === 0) return {};
    const orClauses: Array<Record<string, unknown>> = [];
    for (const lv of levels) {
      if (lv === "PSLE") {
        orClauses.push({ level: { equals: "PSLE", mode: "insensitive" as const } });
        orClauses.push({ title: { contains: "PSLE", mode: "insensitive" as const } });
      } else {
        const n = lv.replace("P", "");
        orClauses.push({ level: { in: [`P${n}`, `Primary ${n}`, n] } });
      }
    }
    return { OR: orClauses };
  })();
  const candidatesRaw = await prisma.examQuestion.findMany({
    where: {
      ...(useRegex
        ? { transcribedStem: { not: null } }
        : useClassifier
          ? { ...syllabusTopicClause, transcribedStem: { not: null } }
          : useGeneralPool
            ? { ...syllabusTopicClause, transcribedStem: { not: null } }
            : { ...syllabusTopicClause, transcribedStem: { not: null }, subTopic: { not: null } }),
      examPaper: {
        sourceExamId: null,
        paperType: null,
        ...(useRegex ? { subject: { contains: content.subject, mode: "insensitive" } } : {}),
        ...paperLevelClause,
      },
    },
    select: {
      id: true,
      questionNum: true,
      examPaperId: true,
      imageData: true,
      answer: true,
      answerImageData: true,
      marksAvailable: true,
      syllabusTopic: true,
      subTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      transcribedSubparts: true,
      diagramImageData: true,
      diagramBounds: true,
      elaboration: true,
      // Paper context for source-aware prioritisation (PSLE > recent
      // school > synthetic bank) inside the per-sub-topic picker.
      examPaper: { select: { title: true, year: true, level: true, examType: true } },
    },
    take: useRegex ? 4000 : undefined,
  });
  const candidatesAfterRegex = useRegex
    ? candidatesRaw.filter(q => {
        try { return new RegExp(content.practiceStemRegex!, "i").test(q.transcribedStem ?? ""); }
        catch { return false; }
      })
    : candidatesRaw;

  // Drop questions that already appear on the master class slides
  // (interactive quiz cards) so the practice quiz doesn't repeat them.
  // We match by a normalised stem prefix: strip markdown bold, collapse
  // blanks/whitespace, lowercase, take the first 60 chars. That's
  // tolerant of small punctuation/blank-length differences between the
  // YAML stem and the OCR'd version in the DB.
  function normaliseStem(s: string): string {
    return s
      .replace(/\*\*|__/g, "")
      .replace(/[_\-]{2,}/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 60);
  }
  const slideStemKeys = new Set<string>();
  for (const slide of content.keyConcepts) {
    for (const iq of slide.interactiveQuiz ?? []) {
      const key = normaliseStem(iq.stem ?? "");
      if (key) slideStemKeys.add(key);
    }
  }
  const candidates = slideStemKeys.size === 0
    ? candidatesAfterRegex
    : candidatesAfterRegex.filter(q => {
        const key = normaliseStem(q.transcribedStem ?? "");
        return !key || !slideStemKeys.has(key);
      });

  // ─── Passage-bound branch (Comp Cloze, Visual Text, 短文填空, etc.) ──
  // Some master classes target syllabus topics where each "question"
  // is one blank in a shared passage — Comp Cloze (15 blanks per
  // passage), Visual Text MCQ (8 questions about a poster), Chinese
  // 短文填空 / 阅读理解. These can't be picked one-at-a-time because
  // they only make sense WITH their passage context. Instead we pull
  // entire passage sections as units, copy each passage into the
  // mastery quiz paper's metadata.englishSections / chineseSections
  // (same shape Daily Quiz uses), and let the quiz UI render
  // passage + questions side-by-side.
  const PASSAGE_BOUND_TOPICS = new Set<string>([
    // English
    "Comprehension Cloze",
    "Visual Text Comprehension MCQ",
    "Comprehension Open Ended",
    "Grammar Cloze",
    "Editing (Spelling & Grammar)",
    // Chinese
    "短文填空",
    "阅读理解 MCQ",
    "阅读理解 OEQ",
    // 完成对话 (sentence completion / dialogue) needs the same
    // passage + word-bank rendering Grammar Cloze uses — without
    // the dialogue context and the numbered phrase bank the
    // student has nothing to pick from. ChineseQuizSection keys off
    // the section label ("完成对话" / "对话填空") to switch to
    // grammar-cloze sectionType.
    "完成对话",
  ]);
  const passageBoundLabels = [content.topicLabel, ...(content.topicLabelExtras ?? [])];
  const isPassageBound = passageBoundLabels.some(l => PASSAGE_BOUND_TOPICS.has(l));

  if (isPassageBound) {
    type PCandidate = typeof candidates[number];
    type PassageGroup = { paperId: string; topic: string; questions: PCandidate[] };
    // 1. Group candidates by (examPaperId, syllabusTopic). Each group
    //    is one passage section (e.g. "Comprehension Cloze" on PSLE
    //    English 2024 — all 15 blanks).
    //
    // For passage-bound topics we group from candidatesAfterRegex
    // (BEFORE the slide-example filter) so the group's question count
    // matches the passage's blank count. Removing slide-example
    // questions would leave a passage with N blanks but N-k questions —
    // the quiz UI binds blanks to questions positionally, so the
    // trailing blanks would render as plain "______" underscores and
    // the option pickers shift to the wrong positions. Hit on
    // 短文填空 master quiz: 4 passages × (5 blanks - 1 slide example)
    // = 4 missing pickers per quiz. Standalone topics keep using the
    // filtered candidates so they don't repeat slide content.
    const pgPool = candidatesAfterRegex;
    const pgMap = new Map<string, PassageGroup>();
    for (const q of pgPool) {
      // Skip questions that aren't on a passage-bound topic — when
      // an MC uses topicLabelExtras, only the extras that ARE
      // passage-bound contribute. (Example: a hypothetical MC that
      // spans both 完成对话 standalone and 短文填空 — the dialogue
      // questions don't need a passage.)
      const topic = q.syllabusTopic ?? "";
      if (!PASSAGE_BOUND_TOPICS.has(topic)) continue;
      const key = `${q.examPaperId}::${topic}`;
      let g = pgMap.get(key);
      if (!g) { g = { paperId: q.examPaperId, topic, questions: [] }; pgMap.set(key, g); }
      g.questions.push(q);
    }
    const allPassageGroups = [...pgMap.values()];
    for (const g of allPassageGroups) {
      g.questions.sort((a, b) =>
        a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }),
      );
    }

    // 2. Shuffle + pick passages. Two constraints:
    //    a) hit the quiz spec's question target,
    //    b) include AT LEAST 2 passages so the student sees variety
    //       — a single Comp Cloze passage covers the full spec
    //       (15 blanks = 15-question target), but practising on
    //       only one passage shape doesn't transfer; rotating across
    //       two passages each quiz is the minimum educational unit.
    //    If the pool only has 1 passage, fall back to that one.
    //    Per-class override: quizSpec.minPassages lets a master class
    //    say "one passage is enough" (e.g. 短文填空 master quiz is
    //    only ~4 questions and 2 passages would balloon it).
    const allSlidesPG = [...content.keyConcepts, ...content.commonMistakes];
    const pgSpec = allSlidesPG.map(s => s.cta?.quizSpec).find(Boolean);
    const MIN_PASSAGES = (pgSpec as { minPassages?: number } | undefined)?.minPassages ?? 2;
    const pgTarget = (pgSpec?.mcq ?? QUIZ_MCQ_COUNT) + (pgSpec?.oeq ?? QUIZ_OEQ_COUNT);
    const shuffledGroups = shuffle(allPassageGroups);
    const pickedGroups: PassageGroup[] = [];
    let runCount = 0;
    for (const g of shuffledGroups) {
      // Keep picking while EITHER we haven't reached the question
      // target OR we haven't hit the minimum-passages floor yet.
      const hitTarget = runCount >= pgTarget;
      const hitMinPassages = pickedGroups.length >= MIN_PASSAGES;
      if (hitTarget && hitMinPassages) break;
      pickedGroups.push(g);
      runCount += g.questions.length;
    }
    if (pickedGroups.length === 0) {
      return NextResponse.json({ error: "No passage sections available to build a quiz." }, { status: 400 });
    }

    // 3. Fetch source-paper metadata for each picked group's passage.
    const pgPaperIds = [...new Set(pickedGroups.map(g => g.paperId))];
    const pgSourcePapers = await prisma.examPaper.findMany({
      where: { id: { in: pgPaperIds } },
      select: { id: true, subject: true, metadata: true, year: true },
    });
    const pgSourceMap = new Map(pgSourcePapers.map(p => [p.id, p]));

    // 4. Flatten the picked groups in section order + build sections metadata.
    // blankIndices = the ORIGINAL passage blank position for each
    // picked question (parallel to the section's flatItems range).
    // Needed so the renderer can place option pickers at the right
    // blank when the picker took a subset of the original section's
    // questions (e.g. 3 of 6 from PSLE 2014 短文填空 because 3 were
    // slide examples). Without this, the renderer assigned picked
    // questions sequentially to blanks 0..N-1, leaving later blanks
    // unrendered and shifting options to the wrong sentences.
    type SectionEntry = { label: string; startIndex: number; endIndex: number; passage?: string; blankIndices?: number[] };
    type FlatItem = { source: PCandidate; sourcePaperId: string };
    const flatItems: FlatItem[] = [];
    const englishSections: SectionEntry[] = [];
    const chineseSections: SectionEntry[] = [];

    // Pre-fetch the FULL question list for each (paperId, topic) the
    // picker chose, sorted by questionNum. Each picked question's
    // index in this sorted list = its blank position in the original
    // passage. The answer + transcribedOptions are also pulled so
    // unpicked blanks can be substituted with their correct answer
    // in the displayed passage (instead of leaving them as plain
    // ______ which confuses the student).
    type FullListEntry = { id: string; questionNum: string; answer: string | null; transcribedOptions: unknown };
    const sectionKeyOf = (paperId: string, topic: string) => `${paperId}::${topic}`;
    const fullSectionLists = new Map<string, FullListEntry[]>();
    for (const g of pickedGroups) {
      const key = sectionKeyOf(g.paperId, g.topic);
      if (fullSectionLists.has(key)) continue;
      const allQs = await prisma.examQuestion.findMany({
        where: { examPaperId: g.paperId, syllabusTopic: g.topic },
        orderBy: { orderIndex: "asc" },
        select: { id: true, questionNum: true, answer: true, transcribedOptions: true },
      });
      // Sort by questionNum NATURALLY so Q16 < Q17 < ... < Q21 (string
      // sort would put Q19 before Q2).
      allQs.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
      fullSectionLists.set(key, allQs);
    }

    // Helper: get the correct-answer text for a question. Returns
    // null when answer or options are missing (caller falls back to
    // leaving the blank empty rather than showing "(no answer)").
    function correctAnswerText(q: FullListEntry): string | null {
      const digit = q.answer?.match(/\d/)?.[0];
      if (!digit) return null;
      const opts = q.transcribedOptions as string[] | null;
      if (!Array.isArray(opts)) return null;
      const idx = parseInt(digit, 10) - 1;
      return opts[idx] ?? null;
    }

    for (const g of pickedGroups) {
      const startIdx = flatItems.length;
      const src = pgSourceMap.get(g.paperId);
      const meta = (src?.metadata as Record<string, unknown> | null) ?? null;
      const subjectLc = (src?.subject ?? content.subject).toLowerCase();
      const isChinesePG = subjectLc.includes("chinese");

      // Pull the passage. Chinese papers carry a fully-built
      // chineseSections array; English papers carry per-section OCR
      // texts that we synthesise into a passage using the same rules
      // Daily Quiz uses.
      let passage: string | undefined;
      if (isChinesePG) {
        // 1st-choice: chineseSections array carries the cleaned
        // passage Daily Quiz prefers (set during extraction for
        // 短文填空 and 阅读理解 MCQ).
        const cs = (meta?.chineseSections as Array<{ label: string; passage?: string }> | undefined) ?? [];
        passage = cs.find(s => s.label === g.topic)?.passage;
        // Fallback: 阅读理解 OEQ doesn't always make it into
        // chineseSections, but the OCR text for the section IS in
        // sectionOcrTexts. Use it as the passage so the quiz can
        // render the reading passage above the OEQ questions.
        if (!passage) {
          const ot = meta?.sectionOcrTexts as Record<string, {
            ocrText?: string;
            passageOcrText?: string;
            passageDisplayText?: string;
          }> | undefined;
          const s = ot?.[g.topic];
          passage = s?.passageOcrText ?? s?.passageDisplayText ?? s?.ocrText;
        }
        // Substitute blanks for which the picker DIDN'T take the
        // question with the correct answer text. Only applies to
        // 短文填空 (visual-text-mcq with passage). Other passage
        // shapes leave the passage untouched. The renderer still
        // sees `**______**` markers for the picked blanks; the
        // substituted ones become plain prose and aren't treated
        // as blanks.
        if (passage && g.topic === "短文填空") {
          const fullList = fullSectionLists.get(sectionKeyOf(g.paperId, g.topic)) ?? [];
          const pickedIds = new Set(g.questions.map(q => q.id));
          let blankCounter = 0;
          passage = passage.replace(/\*\*[^*]*\*\*/g, (match) => {
            const idx = blankCounter++;
            const sourceQ = fullList[idx];
            if (!sourceQ || pickedIds.has(sourceQ.id)) return match;
            const answer = correctAnswerText(sourceQ);
            return answer ? answer : match;
          });
        }
      } else {
        const ocrTexts = meta?.sectionOcrTexts as Record<string, {
          ocrText?: string;
          passageOcrText?: string;
          passageDisplayText?: string;
          passagePageIndices?: number[];
        }> | undefined;
        const sectionOcr = ocrTexts?.[g.topic];
        const topicLc = g.topic.toLowerCase();
        const isVisualText = topicLc.includes("visual") && topicLc.includes("text");
        const isCompOeq = topicLc.includes("comprehension") && !topicLc.includes("cloze");
        if (isVisualText && sectionOcr?.passagePageIndices?.length) {
          // Visual Text uses the back-pointing format Daily Quiz
          // uses — the quiz UI loads the rasterised page from the
          // SOURCE paper, not the mastery clone.
          passage = `[VISUAL_PAGES:${g.paperId}:${sectionOcr.passagePageIndices.join(",")}]`;
        } else if (isCompOeq) {
          passage = sectionOcr?.passageOcrText ?? sectionOcr?.ocrText;
        } else {
          passage = sectionOcr?.passageDisplayText ?? sectionOcr?.ocrText ?? sectionOcr?.passageOcrText;
        }
      }

      for (const q of g.questions) {
        flatItems.push({ source: q, sourcePaperId: g.paperId });
      }
      // Compute blank index per picked question. Index = the question's
      // position when ALL same-section questions in the source paper
      // are sorted by questionNum.
      //
      // For 短文填空 we already substituted unpicked blanks with their
      // correct answer above — that turns the passage into one where
      // the remaining blank count exactly equals the picked question
      // count, in the same order. So sequential mapping works and we
      // do NOT emit blankIndices (the renderer's sequential fallback
      // is correct; emitting original positions would mis-match the
      // post-substitution blank-counter).
      //
      // For other passage-bound shapes (Comp Cloze, etc.) blankIndices
      // is still the right hint when the picker took a sparse subset.
      const fullList = fullSectionLists.get(sectionKeyOf(g.paperId, g.topic)) ?? [];
      const blankIdxByQid = new Map<string, number>();
      for (let i = 0; i < fullList.length; i++) blankIdxByQid.set(fullList[i].id, i);
      const blankIndices = g.questions.map(q => blankIdxByQid.get(q.id) ?? -1);
      const substitutedShortCloze = isChinesePG && g.topic === "短文填空";

      // Label includes source paper year/topic so a student doing 3
      // PSLE Comp Cloze passages in one quiz sees them distinguished.
      const labelSuffix = src?.year ? ` — ${src.year}` : "";
      const entry: SectionEntry = {
        label: `${g.topic}${labelSuffix}`,
        startIndex: startIdx,
        endIndex: flatItems.length - 1,
        ...(passage ? { passage } : {}),
        ...(!substitutedShortCloze && blankIndices.some(i => i >= 0) ? { blankIndices } : {}),
      };
      if (isChinesePG) chineseSections.push(entry);
      else englishSections.push(entry);
    }

    // 4b. Mixed-mode classes: when the master class's topicLabel set
    //     includes BOTH a passage-bound topic and a standalone topic
    //     (e.g. chinese-sentence-completion pulls 完成对话 +
    //     语文应用 MCQ), pick standalone questions from the
    //     non-passage-bound topics too and append them as their own
    //     section. The quiz player keys off the section LABEL to
    //     pick render shape — "语文应用 MCQ" / "Grammar MCQ" etc.
    //     hit the visual-text-mcq path with no passage, which is
    //     exactly the standalone-MCQ layout we want.
    const standaloneLabels = passageBoundLabels.filter(l => !PASSAGE_BOUND_TOPICS.has(l));
    if (standaloneLabels.length > 0) {
      type StandaloneCandidate = typeof candidates[number];
      const standaloneCandidates: StandaloneCandidate[] = candidates.filter(
        q => standaloneLabels.includes(q.syllabusTopic ?? ""),
      );
      if (standaloneCandidates.length > 0) {
        // Same per-class spec the passage-bound branch reads above —
        // count how many we've already added via passage groups and
        // top up from the standalone pool. Standalone questions don't
        // get round-trip dedup (the focused-test fingerprinting isn't
        // wired here yet) but a simple shuffle + slice gives variety.
        const slidesSA = [...content.keyConcepts, ...content.commonMistakes];
        const saSpec = slidesSA.map(s => s.cta?.quizSpec).find(Boolean);
        const saTarget = (saSpec?.mcq ?? QUIZ_MCQ_COUNT) + (saSpec?.oeq ?? QUIZ_OEQ_COUNT);
        const saRemaining = Math.max(0, saTarget - flatItems.length);
        if (saRemaining > 0) {
          const shuffled = shuffle(standaloneCandidates).slice(0, saRemaining);
          // Group by source topic so each standalone topic becomes
          // one section. Preserves the player's per-section header.
          const byTopic = new Map<string, StandaloneCandidate[]>();
          for (const q of shuffled) {
            const topic = q.syllabusTopic ?? "";
            if (!byTopic.has(topic)) byTopic.set(topic, []);
            byTopic.get(topic)!.push(q);
          }
          for (const [topic, qs] of byTopic) {
            const startIdx = flatItems.length;
            for (const q of qs) flatItems.push({ source: q, sourcePaperId: q.examPaperId });
            const entry: SectionEntry = {
              label: topic,
              startIndex: startIdx,
              endIndex: flatItems.length - 1,
            };
            // Chinese-shape topics land in chineseSections, English
            // in englishSections — mirrors the per-question subject
            // detection above.
            const isChineseTopic = /[一-鿿]/.test(topic);
            if (isChineseTopic) chineseSections.push(entry);
            else englishSections.push(entry);
          }
        }
      }
    }

    // 5. Quiz numbering + paper creation.
    const pgPriorCount = await prisma.examPaper.count({
      where: {
        assignedToId: studentId,
        paperType: "mastery",
        metadata: { path: ["masterClassSlug"], equals: slug } as never,
      },
    });
    const pgQuizNumber = pgPriorCount + 1;
    const pgTotalMarks = flatItems.reduce(
      (s, item) => s + (hasOptions(item.source) ? 2 : (item.source.marksAvailable ?? 1)),
      0,
    );

    const pgPaper = await prisma.examPaper.create({
      data: {
        title: `Mastery: ${content.title} Quiz ${pgQuizNumber}`,
        subject: content.subject,
        level: student?.level ? `P${student.level}` : null,
        userId: sessionUserId,
        assignedToId: studentId,
        paperType: "mastery",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(pgTotalMarks),
        metadata: {
          masterClassSlug: slug,
          masterClassTitle: content.title,
          quizNumber: pgQuizNumber,
          passageBound: true,
          ...(englishSections.length > 0 ? { englishSections } : {}),
          ...(chineseSections.length > 0 ? { chineseSections } : {}),
          ...(body.parentMasteryId ? { parentMasteryId: body.parentMasteryId } : {}),
          warnings: [],
        } as never,
        questions: {
          create: flatItems.map((item, i) => ({
            questionNum: String(i + 1),
            imageData: item.source.imageData,
            answer: item.source.answer,
            answerImageData: item.source.answerImageData,
            marksAvailable: hasOptions(item.source) ? 2 : (item.source.marksAvailable ?? 1),
            syllabusTopic: item.source.syllabusTopic,
            subTopic: item.source.subTopic,
            pageIndex: 0,
            orderIndex: i,
            transcribedStem: item.source.transcribedStem,
            transcribedOptions: item.source.transcribedOptions ?? undefined,
            transcribedOptionImages: item.source.transcribedOptionImages ?? undefined,
            transcribedOptionTable: item.source.transcribedOptionTable ?? undefined,
            transcribedSubparts: item.source.transcribedSubparts ?? undefined,
            diagramImageData: item.source.diagramImageData ?? undefined,
            diagramBounds: item.source.diagramBounds ?? undefined,
            elaboration: item.source.elaboration ?? undefined,
            sourceQuestionId: item.source.id,
          })),
        },
      },
      select: { id: true },
    });

    // Re-use the same review-paper scheduler the standard path uses.
    await upsertPendingReviewPaper({
      slug, content, studentId, sessionUserId,
      studentLevel: student?.level ?? null,
    });
    return NextResponse.json({ paperId: pgPaper.id, warnings: [], quizNumber: pgQuizNumber });
  }

  // ─── Pull OEQ siblings + merge groups ──────────────────────────────
  // A candidate row representing a sub-part of a multi-part question
  // (e.g. "Q14c") would render in the quiz with only its own (c) stem
  // and no parent scenario. Group OEQ candidates by (examPaperId,
  // baseNum), fetch any missing siblings, and merge each group into a
  // single combined question — same approach as focused-test / daily-
  // quiz so "the stems go together".
  type Candidate = typeof candidates[number];
  const oeqCandidates = candidates.filter(q => !hasOptions(q));
  const mcqCandidatesOnly = candidates.filter(q => hasOptions(q));
  const groupKeys = new Set<string>(
    oeqCandidates.map(q => `${q.examPaperId}::${baseNum(q.questionNum)}`),
  );
  const siblingWheres = [...groupKeys].map(k => {
    const [examPaperId, base] = k.split("::");
    return { examPaperId, questionNum: { startsWith: base } };
  });
  const siblingRows: Candidate[] = siblingWheres.length > 0
    ? await prisma.examQuestion.findMany({
        where: {
          OR: siblingWheres,
          // Same paper-level filters as the candidates query so we don't
          // pull a sibling from a paper that was excluded upstream.
          examPaper: { sourceExamId: null, paperType: null },
        },
        select: {
          id: true,
          questionNum: true,
          examPaperId: true,
          imageData: true,
          answer: true,
          answerImageData: true,
          marksAvailable: true,
          syllabusTopic: true,
          subTopic: true,
          transcribedStem: true,
          transcribedOptions: true,
          transcribedOptionImages: true,
          transcribedOptionTable: true,
          transcribedSubparts: true,
          diagramImageData: true,
          diagramBounds: true,
          elaboration: true,
          examPaper: { select: { title: true, year: true, level: true, examType: true } },
        },
      })
    : [];
  const byIdMap = new Map<string, Candidate>();
  for (const q of oeqCandidates) byIdMap.set(q.id, q);
  for (const q of siblingRows) if (!byIdMap.has(q.id)) byIdMap.set(q.id, q);
  const groupMap = new Map<string, Candidate[]>();
  for (const q of byIdMap.values()) {
    const key = `${q.examPaperId}::${baseNum(q.questionNum)}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(q);
  }
  for (const g of groupMap.values()) {
    g.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }
  // For each group, find the candidate that triggered inclusion. Its
  // subTopic / classifier tag drives bucket placement — without this,
  // the merged row would land in the lead sibling's (often null or
  // different) bucket and silently get dropped.
  const triggeringByKey = new Map<string, Candidate>();
  for (const c of oeqCandidates) {
    const key = `${c.examPaperId}::${baseNum(c.questionNum)}`;
    if (!triggeringByKey.has(key)) triggeringByKey.set(key, c);
  }
  const mergeClassifier = STEM_CLASSIFIERS[slug];
  const mergedOeqs: Candidate[] = [];
  for (const [key, group] of groupMap) {
    // SAFETY: the sibling fetch uses `questionNum: startsWith: base`,
    // which overmatches when base is a short string — Q1's siblings
    // also pull Q10, Q11, …, Q19, creating groupMap entries with no
    // triggering candidate. Skip those — they shouldn't be in the
    // mastery pool because they were never in the topic-matched set.
    // (Synthesis crashed here: most questions are single-digit Q-nums
    // so the overmatch hit a huge chunk of the paper.)
    const triggering = triggeringByKey.get(key);
    if (!triggering) continue;
    const merged = mergeOeqGroup(group);
    // Preserve the triggering candidate's classification (not the
    // merged lead stem's) so the merged row lands in the same bucket
    // that got it picked in the first place. Single-sibling groups
    // (no multi-part) are unaffected — merge is a no-op there.
    const explicitSubTopic = mergeClassifier
      ? mergeClassifier(triggering.transcribedStem)
      : triggering.subTopic;
    mergedOeqs.push({ ...merged, subTopic: explicitSubTopic });
  }
  // Replace OEQ rows in the candidate pool with the merged groups.
  // MCQ rows are untouched — MCQ source questions are always single-row.
  const candidatesMerged: Candidate[] = [...mcqCandidatesOnly, ...mergedOeqs];

  // ─── Group by subTopic + mcq/oeq ───────────────────────────────────
  // Three bucketing modes:
  //   - Single-bucket "_all": general-pool master classes (Comp Cloze,
  //     Visual Text MCQ), AND regex-mode classes that DON'T have a
  //     stem classifier registered. Selection rounds from one pool.
  //   - Per-sub-topic: everyone else — including regex-mode classes
  //     WITH a stem classifier (Patterns, Hidden Constant Total).
  //     Classifier output places questions into the YAML's declared
  //     sub-topic buckets, and the picker enforces per-bucket
  //     minimums (subTopicOeqMin) for variety.
  const useSingleBucket = useGeneralPool || (useRegex && !STEM_CLASSIFIERS[slug]);
  const groups = new Map<string, { mcq: Candidate[]; oeq: Candidate[] }>();
  if (useSingleBucket) {
    groups.set("_all", { mcq: [], oeq: [] });
    for (const q of candidatesMerged) {
      const g = groups.get("_all")!;
      if (hasOptions(q)) g.mcq.push(q); else g.oeq.push(q);
    }
  } else {
    for (const st of subTopics) groups.set(st.id, { mcq: [], oeq: [] });
    // Classifier-based slugs (Circuits) re-tag from the stem; pure
    // tagged slugs (Interactions) use the admin-set subTopic field.
    // Merged OEQ rows arrive with subTopic already pre-set above, so
    // prefer that over re-classifying the (merged) lead stem.
    const classifier = STEM_CLASSIFIERS[slug];
    for (const q of candidatesMerged) {
      const subTopicId = q.subTopic ?? (classifier ? classifier(q.transcribedStem) : null);
      if (!subTopicId || !groups.has(subTopicId)) continue;
      const g = groups.get(subTopicId)!;
      if (hasOptions(q)) g.mcq.push(q);
      else g.oeq.push(q);
    }
  }

  // Dedupe each group by the first 200 chars of the transcribed
  // stem. The master bank carries occasional near-duplicate questions
  // (same PSLE question echoed in a school WA paper, or synthetic
  // variants of the same parent), and the round-robin picker would
  // otherwise pull a "repeat" pair into the same quiz.
  function dedupeByStem<T extends { transcribedStem: string | null }>(arr: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const q of arr) {
      const key = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
    return out;
  }

  // Source-aware priority: PSLE first (newest year first), then
  // school papers (newest year first), then synthetic-bank questions.
  // Inside each tier we still shuffle so different students get
  // different mixes. This favours PSLE for the trickier real-paper
  // questions when the bank has more candidates than the quiz needs.
  function sourcePriority(q: { examPaper?: { title?: string | null; year?: string | null; level?: string | null; examType?: string | null } | null }): number {
    const title = q.examPaper?.title ?? "";
    const examType = q.examPaper?.examType ?? "";
    if (/\bPSLE\b/i.test(title) || /^psle$/i.test(q.examPaper?.level ?? "")) return 0; // PSLE first
    if (examType === "Synthetic" || /\[Synthetic Bank\]/i.test(title)) return 2;        // Synthetic last
    return 1;                                                                            // School papers in between
  }
  function yearNum(q: { examPaper?: { year?: string | null } | null }): number {
    const y = (q.examPaper?.year ?? "").match(/\d{4}/)?.[0];
    return y ? parseInt(y, 10) : 0;
  }
  function sortByPriority<T extends { examPaper?: { title?: string | null; year?: string | null; level?: string | null; examType?: string | null } | null }>(arr: T[]): T[] {
    // Stable sort: priority asc, then year desc (newer first).
    return [...arr].sort((a, b) => {
      const pa = sourcePriority(a); const pb = sourcePriority(b);
      if (pa !== pb) return pa - pb;
      return yearNum(b) - yearNum(a);
    });
  }
  // Shuffle within each group, then dedupe by stem, then sort by source priority.
  for (const [, g] of groups) {
    g.mcq = sortByPriority(dedupeByStem(shuffle(g.mcq)));
    g.oeq = dedupeByStem(shuffle(g.oeq));
  }

  // ─── Selection ─────────────────────────────────────────────────────
  type Picked = Candidate;
  const picked: Picked[] = [];
  const warnings: string[] = [];
  // Per-master-class quiz size: YAML can override the defaults via
  // the first slide's cta.quizSpec. (Patterns wants 6 + 4 instead of
  // 10 + 6 because the pool is smaller.)
  const allSlides = [...content.keyConcepts, ...content.commonMistakes];
  const quizSpec = allSlides.map(s => s.cta?.quizSpec).find(Boolean);
  const mcqTarget = quizSpec?.mcq ?? QUIZ_MCQ_COUNT;
  const oeqTarget = quizSpec?.oeq ?? QUIZ_OEQ_COUNT;

  if (useSingleBucket) {
    // Single-bucket pick — just take the first N OEQ then the first
    // N MCQ from the deduped/shuffled pool. Used for general-pool and
    // for regex-mode classes with no classifier registered.
    const g = groups.get("_all")!;
    picked.push(...g.oeq.slice(0, oeqTarget));
    g.oeq = g.oeq.slice(oeqTarget);
    picked.push(...g.mcq.slice(0, mcqTarget));
    g.mcq = g.mcq.slice(mcqTarget);
    if (picked.filter(p => !hasOptions(p)).length < oeqTarget) {
      warnings.push(`Only ${picked.filter(p => !hasOptions(p)).length} OEQ available (wanted ${oeqTarget}).`);
    }
    if (picked.filter(hasOptions).length < mcqTarget) {
      warnings.push(`Only ${picked.filter(hasOptions).length} MCQ available (wanted ${mcqTarget}).`);
    }
  } else if (focusSubTopics.length > 0) {
    // Focused mode: 2 MCQ + 2 OEQ from each listed sub-topic.
    for (const stId of focusSubTopics) {
      const st = subTopics.find(s => s.id === stId);
      if (!st) { warnings.push(`Unknown sub-topic "${stId}".`); continue; }
      const g = groups.get(stId);
      if (!g) { warnings.push(`No questions cached for sub-topic "${st.label}".`); continue; }
      const oeqPick = g.oeq.splice(0, 2);  // up to 2 OEQ per sub-topic
      const mcqPick = g.mcq.splice(0, 2);  // 2 MCQ per sub-topic
      picked.push(...oeqPick, ...mcqPick);
      if (oeqPick.length === 0) warnings.push(`No OEQ available for sub-topic "${st.label}".`);
      if (mcqPick.length === 0) warnings.push(`No MCQ available for sub-topic "${st.label}".`);
    }
  } else {
    // Pick the per-sub-topic minimum OEQs first. quizSpec.subTopicOeqMin
    // lets a class enforce more than 1 OEQ from a particular topic
    // (Electrical Circuits forces 2 electromagnet OEQs because they
    // dominate the PSLE OEQ marks). Defaults to 1 per sub-topic when
    // not overridden.
    const subTopicOeqMin = quizSpec?.subTopicOeqMin ?? {};
    for (const st of subTopics) {
      const g = groups.get(st.id)!;
      const minN = Math.max(1, subTopicOeqMin[st.id] ?? 1);
      if (g.oeq.length === 0) {
        warnings.push(`No OEQ available for sub-topic "${st.label}".`);
        continue;
      }
      const takeN = Math.min(minN, g.oeq.length);
      picked.push(...g.oeq.splice(0, takeN));
      if (takeN < minN) {
        warnings.push(`Only ${takeN} OEQ available for sub-topic "${st.label}" (wanted ${minN}).`);
      }
    }
    // Top up to oeqTarget total if any sub-topic was missing.
    while (picked.filter(p => !hasOptions(p)).length < oeqTarget) {
      const fallback = [...groups.entries()].sort((a, b) => b[1].oeq.length - a[1].oeq.length)[0];
      if (!fallback || fallback[1].oeq.length === 0) break;
      picked.push(fallback[1].oeq.shift()!);
    }
    // Pick MCQ round-robin from sub-topics until we hit mcqTarget.
    let mcqPickedCount = 0;
    let rounds = 0;
    while (mcqPickedCount < mcqTarget && rounds < 50) {
      rounds++;
      let progressed = false;
      for (const st of subTopics) {
        if (mcqPickedCount >= mcqTarget) break;
        const g = groups.get(st.id)!;
        if (g.mcq.length === 0) continue;
        picked.push(g.mcq.shift()!);
        mcqPickedCount++;
        progressed = true;
      }
      if (!progressed) break;
    }
    if (mcqPickedCount < mcqTarget) {
      warnings.push(`Only ${mcqPickedCount} MCQ available across sub-topics (wanted ${mcqTarget}).`);
    }
  }

  if (picked.length === 0) {
    return NextResponse.json({ error: "No questions available to build a quiz." }, { status: 400 });
  }

  // Final order: MCQ block first, then OEQ block. Matches standard
  // PSLE paper structure (Booklet A = MCQ, Booklet B = OEQ) and
  // makes the quiz UI render cleanly without OEQ stems landing
  // mid-MCQ.
  const finalPicked = [
    ...picked.filter(q => hasOptions(q)),
    ...picked.filter(q => !hasOptions(q)),
  ];

  // ─── Create the mastery paper ──────────────────────────────────────
  // Quiz number for this student on this master class (so the title
  // increments on retake: Quiz 1, Quiz 2, ...).
  const priorMasteryCount = await prisma.examPaper.count({
    where: {
      assignedToId: studentId,
      paperType: "mastery",
      metadata: { path: ["masterClassSlug"], equals: slug } as never,
    },
  });
  const quizNumber = priorMasteryCount + 1;

  const totalMarks = finalPicked.reduce(
    (s, q) => s + (hasOptions(q) ? 2 : (q.marksAvailable ?? 1)),
    0,
  );

  // Title reflects mode. Focused quizzes include the sub-topic
  // labels so the student knows what's being targeted.
  let title: string;
  if (focusSubTopics.length > 0) {
    const labels = focusSubTopics
      .map(id => subTopics.find(s => s.id === id)?.label ?? id)
      .filter(Boolean);
    title = `Mastery: ${content.title} — focus on ${labels.join(", ")}`;
  } else {
    title = `Mastery: ${content.title} Quiz ${quizNumber}`;
  }

  // English Synthesis & Transformation needs the quiz player's
  // dedicated synthesis renderer (keyword + input boxes from
  // EnglishQuizSection's sectionType="synthesis"), not the default
  // OEQ textarea. The quiz player keys off metadata.englishSections —
  // stamp a single section spanning every picked question so the
  // page detects this as a synthesis section. Other English master
  // classes (Visual Text, Comp Cloze, etc.) already go through the
  // passage-bound branch above and stamp their own englishSections.
  const isSynthesisMastery = (content.topicLabel ?? "").toLowerCase().includes("synthesis");
  const synthesisEnglishSections = isSynthesisMastery && finalPicked.length > 0
    ? [{
        label: "Synthesis & Transformation",
        startIndex: 0,
        endIndex: finalPicked.length - 1,
      }]
    : undefined;

  const paper = await prisma.examPaper.create({
    data: {
      title,
      subject: content.subject,
      level: student?.level ? `P${student.level}` : null,
      userId: sessionUserId,
      assignedToId: studentId,
      paperType: "mastery",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        masterClassSlug: slug,
        masterClassTitle: content.title,
        quizNumber,
        ...(focusSubTopics.length > 0 ? { focusSubTopics } : {}),
        ...(body.parentMasteryId ? { parentMasteryId: body.parentMasteryId } : {}),
        ...(synthesisEnglishSections ? { englishSections: synthesisEnglishSections } : {}),
        warnings,
      } as never,
      questions: {
        create: finalPicked.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: hasOptions(q) ? 2 : (q.marksAvailable ?? 1),
          syllabusTopic: q.syllabusTopic,
          // For classes with a stem classifier (Patterns, Circuits…),
          // re-tag at clone time. Source questions for these master
          // classes don't have admin-set subTopic, so the classifier
          // fills it from the stem keywords. Falls through to the
          // source's subTopic for classes that don't need it. For
          // merged multi-part OEQs we already pre-set q.subTopic from
          // the triggering sibling's classification — prefer that so
          // the clone matches the bucket it was picked from.
          subTopic: q.subTopic ?? (STEM_CLASSIFIERS[slug]?.(q.transcribedStem) ?? null),
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedOptionTable: q.transcribedOptionTable ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          // Carry the diagram fields and elaboration through to the
          // cloned question — matches the focused-test create. Without
          // diagramImageData, charts/figures referenced by the stem
          // never appeared on the mastery quiz page.
          diagramImageData: q.diagramImageData ?? undefined,
          diagramBounds: q.diagramBounds ?? undefined,
          elaboration: q.elaboration ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true },
  });

  // ─── Auto-review scheduling ────────────────────────────────────────
  // Every new mastery quiz resets the 7-day review timer. We delete
  // any existing PENDING (uncompleted) review paper for (student,
  // slug), then create a fresh one with scheduledFor = now + 7 days,
  // containing every wrong source-question from past completed quizzes.
  // Skipped if the student has no wrong questions on record.
  await upsertPendingReviewPaper({ slug, content, studentId, sessionUserId, studentLevel: student?.level ?? null });

  return NextResponse.json({ paperId: paper.id, warnings, quizNumber });
}

// Delete any uncompleted "Master Class X Review" paper for the
// student × slug, then create a fresh one if there are wrong source
// questions on record. Idempotent — safe to call after every quiz.
async function upsertPendingReviewPaper(params: {
  slug: string;
  content: { title: string; subject: string };
  studentId: string;
  sessionUserId: string;
  studentLevel: number | null;
}) {
  const { slug, content, studentId, sessionUserId, studentLevel } = params;

  // 1. Delete pending reviews for this (student, slug) — never delete
  //    a completed one (preserves history). "Pending" = no completedAt.
  await prisma.examPaper.deleteMany({
    where: {
      assignedToId: studentId,
      paperType: "mastery-review",
      completedAt: null,
      metadata: { path: ["masterClassSlug"], equals: slug } as never,
    },
  });

  // 2. Collect wrong source-question IDs.
  const sourceIds = await getWrongSourceQuestionIds(slug, studentId);
  if (sourceIds.length === 0) return;

  // 3. Fetch full source questions so the cloned review has the same
  //    fields as a normal mastery quiz.
  const sourceSelect = {
    id: true,
    questionNum: true,
    examPaperId: true,
    imageData: true,
    answer: true,
    answerImageData: true,
    marksAvailable: true,
    syllabusTopic: true,
    subTopic: true,
    transcribedStem: true,
    transcribedOptions: true,
    transcribedOptionImages: true,
    transcribedOptionTable: true,
    transcribedSubparts: true,
    diagramImageData: true,
    diagramBounds: true,
    elaboration: true,
  } as const;
  const sourceQuestions = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: sourceSelect,
  });
  type SourceQ = typeof sourceQuestions[number];

  // Pull in siblings of every source row by (examPaperId, baseNum) so
  // multi-part questions render in the review with all sub-parts, not
  // just the lead row the mastery clone pointed at. Without this, a
  // student who got "Q14 (c)" wrong would see only the (c) stem on the
  // review paper — same bug the main mastery picker had pre-fix.
  const reviewGroupKeys = new Set<string>(
    sourceQuestions.map(q => `${q.examPaperId}::${baseNum(q.questionNum)}`),
  );
  const reviewSiblingWheres = [...reviewGroupKeys].map(k => {
    const [examPaperId, base] = k.split("::");
    return { examPaperId, questionNum: { startsWith: base } };
  });
  const reviewSiblings: SourceQ[] = reviewSiblingWheres.length > 0
    ? await prisma.examQuestion.findMany({
        where: {
          OR: reviewSiblingWheres,
          examPaper: { sourceExamId: null, paperType: null },
        },
        select: sourceSelect,
      })
    : [];
  const reviewById = new Map<string, SourceQ>();
  for (const q of sourceQuestions) reviewById.set(q.id, q);
  for (const q of reviewSiblings) if (!reviewById.has(q.id)) reviewById.set(q.id, q);
  const reviewGroupMap = new Map<string, SourceQ[]>();
  for (const q of reviewById.values()) {
    const key = `${q.examPaperId}::${baseNum(q.questionNum)}`;
    if (!reviewGroupMap.has(key)) reviewGroupMap.set(key, []);
    reviewGroupMap.get(key)!.push(q);
  }
  for (const g of reviewGroupMap.values()) {
    g.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }
  // Walk sourceIds in their original (most-recent-wrong-first) order
  // and emit one merged group per unique key. Multiple wrong clones
  // pointing to siblings of the same source group collapse into one
  // review entry rather than repeating the same combined question.
  const sourceById = new Map(sourceQuestions.map(q => [q.id, q]));
  const seenReviewKeys = new Set<string>();
  const orderedSources: SourceQ[] = [];
  for (const id of sourceIds) {
    const trigger = sourceById.get(id);
    if (!trigger) continue;
    const key = `${trigger.examPaperId}::${baseNum(trigger.questionNum)}`;
    if (seenReviewKeys.has(key)) continue;
    const group = reviewGroupMap.get(key);
    if (!group) continue;
    seenReviewKeys.add(key);
    orderedSources.push(mergeOeqGroup(group));
  }

  // 4. Create the review paper, scheduledFor = now + 7 days.
  const scheduledFor = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const isMcq = (q: typeof orderedSources[number]) => {
    if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
    if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
    const t = q.transcribedOptionTable;
    if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
    return false;
  };
  const totalMarks = orderedSources.reduce(
    (s, q) => s + (isMcq(q) ? 2 : (q.marksAvailable ?? 1)),
    0,
  );

  await prisma.examPaper.create({
    data: {
      title: `Master Class: ${content.title} — Review`,
      subject: content.subject,
      level: studentLevel != null ? `P${studentLevel}` : null,
      userId: sessionUserId,
      assignedToId: studentId,
      paperType: "mastery-review",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      scheduledFor,
      totalMarks: String(totalMarks),
      metadata: {
        masterClassSlug: slug,
        masterClassTitle: content.title,
        kind: "auto-review",
        wrongCount: orderedSources.length,
      } as never,
      questions: {
        create: orderedSources.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: isMcq(q) ? 2 : (q.marksAvailable ?? 1),
          syllabusTopic: q.syllabusTopic,
          subTopic: q.subTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedOptionTable: q.transcribedOptionTable ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData ?? undefined,
          diagramBounds: q.diagramBounds ?? undefined,
          elaboration: q.elaboration ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
  });
}
