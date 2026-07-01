import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getStudentDifficultyMode, resolveDifficultyFilter, modeWarningLabel } from "@/lib/difficulty-filter";
import { guardCanAssign } from "@/lib/subscription";
import { isCompOeqLabel } from "@/lib/english-sections";
import { isAdmin } from "@/lib/admin";
import { LEGACY_TOPICS } from "@/lib/legacy-topics";

/** MCQ = question has transcribed options (text, images, or
 *  table). An array of 4 entries (even empty) means MCQ — the
 *  extraction created option slots. Table-format MCQ is detected
 *  by a non-null transcribedOptionTable with the right shape. */
function hasOptions(q: { transcribedOptions?: unknown; transcribedOptionImages?: unknown; transcribedOptionTable?: unknown }): boolean {
  const opts = q.transcribedOptions;
  const imgs = q.transcribedOptionImages;
  const tbl = q.transcribedOptionTable;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  if (tbl && typeof tbl === "object" && Array.isArray((tbl as { rows?: unknown }).rows) && (tbl as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

/** Check if the answer VALUE is a single MCQ digit (1-4). Used only for English quiz
 *  section classification where the same section may have both MCQ and written answers. */
function isMcq(answer: string | null): boolean {
  const n = (answer ?? "").trim().replace(/[().]/g, "").trim();
  return n === "1" || n === "2" || n === "3" || n === "4";
}

// Phase-level timing for the daily-quiz route. Logs `[daily-quiz timing]`
// lines that give us per-phase ms so we can spot the slow ones in
// Railway logs. Lightweight — single timestamp diff per phase.
function mkPhaseTimer(reqId: string) {
  const start = Date.now();
  let last = start;
  return {
    mark(label: string) {
      const now = Date.now();
      console.log(`[daily-quiz timing] ${reqId} ${label}: ${now - last}ms (total ${now - start}ms)`);
      last = now;
    },
    total() { return Date.now() - start; },
  };
}

export async function POST(request: NextRequest) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const T = mkPhaseTimer(reqId);
  const { userId, studentId, quizType, subject, englishSections, chineseSections, sourcePaperId, scheduledFor, focused, revisionLevel, firstQuiz } = await request.json() as {
    userId: string;
    studentId?: string;
    quizType: "mcq" | "mcq-oeq";
    subject?: "math" | "science" | "english" | "chinese";
    englishSections?: string[];
    chineseSections?: string[]; // admin: section labels (e.g. "短文填空", "阅读理解 A")
    sourcePaperId?: string; // admin: generate test quiz from specific paper
    scheduledFor?: string; // ISO date; when the quiz should appear on the student's dashboard
    focused?: boolean; // when true + english + single section, take 2x questions for that section
    firstQuiz?: boolean; // when true (onboarding flow) we cap MCQ count at 15 instead of 20 to soften the first impression
    // Revision mode: when set, draw from this lower level (e.g. 4 for
    // a P5 student) and relax filters — no WA1/2/3 time-of-year gate,
    // no difficulty cap, prefer EOY/Prelim papers, fall back to all
    // exam types if the year-end pool is too thin.
    revisionLevel?: number;
  };
  // Trial / subscription gate. studentId (if present) is the user
  // initiating; otherwise userId is. For student-initiated quizzes
  // the guard also checks linked parents' subscription, so a paying
  // parent's children keep working after the kid's own trial ends.
  const blocked = await guardCanAssign(studentId || userId);
  if (blocked) return blocked;

  const scheduledForDate = scheduledFor ? new Date(scheduledFor) : undefined;
  const isFocusedEnglish = !!focused && subject === "english";

  // ── Admin: generate test quiz from a specific paper ──
  if (sourcePaperId) {
    const paper = await prisma.examPaper.findUnique({
      where: { id: sourcePaperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

    const isEnglish = (paper.subject ?? "").toLowerCase().includes("english");
    const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");
    // English AND Chinese papers: gated test-quiz creation via this
    // path. The parent UI exposes paper-as-quiz assignment only for
    // allow-listed accounts; mirror the same gate here so a non-
    // allow-listed user can't slip a sourcePaperId through the API
    // directly. The Chinese allow-list (src/lib/chinese-access.ts)
    // is reused for English by design — same set of accounts
    // (admin + mark lim / david lim / student666 at the time of
    // writing) is authorised for both.
    if (isEnglish || isChinese) {
      const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, settings: true } });
      const { canAssignChinese } = await import("@/lib/chinese-access");
      if (!isAdmin(actor) && !canAssignChinese(actor?.name)) {
        const which = isChinese ? "Chinese" : "English";
        return NextResponse.json({ error: `${which} papers can only be assigned as a quiz by an authorised account.` }, { status: 403 });
      }
    }
    // Temporary block: P3 English masters have non-standard section
    // formats (e.g. Nanhua 2025 P3 EOY Editing uses "circle the correct
    // word from brackets" instead of inline-blank-with-error-word) that
    // the quiz renderer doesn't support. Refuse to assign them until
    // the extractions are normalised. Mirror the regular-path guard at
    // line ~530 so neither route can serve a P3 English quiz.
    if (isEnglish && paper.level === "Primary 3") {
      return NextResponse.json({ error: "Primary 3 English is not yet supported." }, { status: 400 });
    }
    const allQs = paper.questions.filter(q => q.answer);
    if (allQs.length === 0) return NextResponse.json({ error: "No questions with answers" }, { status: 404 });

    const mcqQs = allQs.filter(q => {
      const n = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      return n === "1" || n === "2" || n === "3" || n === "4";
    });
    const oeqQs = allQs.filter(q => {
      const n = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      return !(n === "1" || n === "2" || n === "3" || n === "4");
    });
    const totalMarks = allQs.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);

    // Build English sections if applicable
    let englishSectionsMeta: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | undefined;
    if (isEnglish) {
      const sectionMap = new Map<string, typeof allQs>();
      for (const q of allQs) {
        const topic = q.syllabusTopic ?? "Other";
        if (!sectionMap.has(topic)) sectionMap.set(topic, []);
        sectionMap.get(topic)!.push(q);
      }
      // Sort sections in standard English paper order
      // Both Synthesis forms listed — extraction/marking write
      // "Synthesis & Transformation"; older AI normaliser wrote
      // "Synthesis / Transformation". Either should sort to the
      // same slot (right before Comp OEQ), so include both. Without
      // this, a paper tagged with the ampersand form fell through to
      // the indexOf=999 catch-all and rendered AFTER Comp OEQ — which
      // is what the user saw on Maha Bodhi 2025 P4 EL P2 after
      // renaming "Sentence Manipulation - Combining" to "Synthesis &
      // Transformation".
      const sectionOrder = ["Grammar MCQ", "Vocabulary MCQ", "Vocabulary Cloze MCQ", "Visual Text Comprehension MCQ", "Grammar Cloze", "Editing (Spelling & Grammar)", "Comprehension Cloze", "Synthesis & Transformation", "Synthesis / Transformation", "Comprehension Open Ended"];
      const sortedTopics = [...sectionMap.keys()].sort((a, b) => {
        const ai = sectionOrder.indexOf(a);
        const bi = sectionOrder.indexOf(b);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      // Rebuild allQs in section order so question indices match section metadata
      const reorderedQs: typeof allQs = [];
      for (const topic of sortedTopics) reorderedQs.push(...sectionMap.get(topic)!);
      allQs.length = 0;
      allQs.push(...reorderedQs);

      englishSectionsMeta = [];
      let idx = 0;
      const ocrTexts = (paper.metadata as Record<string, unknown>)?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string; passageDisplayText?: string; passagePageIndices?: number[] }> | undefined;
      // CRITICAL: iterate sortedTopics, NOT sectionMap. sectionMap's
      // entries() reflects INSERTION order from grouping questions —
      // which is whatever questionNum order they came in. reorderedQs
      // (and the order_index assigned to the clones) uses sortedTopics.
      // Iterating sectionMap here produced startIndex/endIndex values
      // pointing at the WRONG section, so Synthesis & Transformation
      // metadata pointed at the Comp Cloze question range and the
      // quiz/review rendered the Synthesis section as blank. Spotted
      // on Maha Bodhi 2025 EOY EL P2 (cmqrh9451000114ggzp74sz3h).
      for (const topic of sortedTopics) {
        const qs = sectionMap.get(topic)!;
        const topicLower = topic.toLowerCase();
        // Don't set passage for standalone MCQ sections (Grammar MCQ, Vocabulary MCQ)
        const isStandaloneMcq = (topicLower.includes("grammar") && !topicLower.includes("cloze") && !topicLower.includes("editing"))
          || (topicLower.includes("vocab") && !topicLower.includes("cloze"));
        const isVisualText = topicLower.includes("visual") && topicLower.includes("text");
        const isCompOeq = topicLower.includes("comprehension") && !topicLower.includes("cloze");
        // Visual text: use [VISUAL_PAGES:paperId:pageIndices] format to load scanned pages
        const sectionOcr = ocrTexts?.[topic];
        let passage: string | undefined;
        if (isStandaloneMcq) {
          passage = undefined;
        } else if (isVisualText && sectionOcr?.passagePageIndices?.length) {
          passage = `[VISUAL_PAGES:${paper.id}:${sectionOcr.passagePageIndices.join(",")}]`;
        } else if (isCompOeq) {
          // Comp OEQ: prefer passageOcrText (reading passage), NOT ocrText (question text)
          passage = sectionOcr?.passageOcrText ?? sectionOcr?.ocrText;
        } else {
          // For cloze sections we now store a cleaned passage-only
          // copy in passageDisplayText (no instruction header, no
          // trailing Q&A block). Prefer that for the quiz UI; fall
          // back to the full ocrText when the cleaner left the OCR
          // unchanged.
          passage = sectionOcr?.passageDisplayText ?? sectionOcr?.ocrText ?? sectionOcr?.passageOcrText;
        }
        englishSectionsMeta.push({
          label: topic,
          startIndex: idx,
          endIndex: idx + qs.length - 1,
          ...(passage ? { passage } : {}),
        });
        idx += qs.length;
      }
    }

    // Chinese sections — parallel to the English block above, NOT
    // shared with it. The Chinese quiz UI keys off
    // metadata.chineseSections (separate field from englishSections)
    // and rendering rules differ per section type, so the build logic
    // forks here. Source: paper.metadata.chineseSections is already
    // built by the extraction pipeline; copy it over and re-anchor
    // the indices to the test quiz's reordered allQs array.
    let chineseSectionsMeta: Array<{ label: string; startIndex: number; endIndex: number; passage?: string; passageImageData?: string }> | undefined;
    if (isChinese) {
      const masterCs = (paper.metadata as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string; passageImageData?: string }> } | null)?.chineseSections;
      if (masterCs) {
        // The test quiz keeps allQs in paper order (no reordering for
        // Chinese — Chinese papers don't have an English-style sortable
        // section order). Each master section's [start..end] range
        // already aligns with allQs indices, so we can copy directly.
        // passageImageData carries the cropped PDF image admins upload
        // for 阅读理解 sections that contain charts / posters / etc.
        chineseSectionsMeta = masterCs.map(s => ({
          label: s.label,
          startIndex: s.startIndex,
          endIndex: s.endIndex,
          ...(s.passage ? { passage: s.passage } : {}),
          ...(s.passageImageData ? { passageImageData: s.passageImageData } : {}),
        }));
      }
    }

    // Target student: prefer the explicit `studentId` field — the
    // parent UI sends both `userId` (the actor) and `studentId`
    // (the child the quiz is for) when assigning English / Chinese
    // papers as quiz-format. Falls back to `userId` so admin-as-self
    // "test quiz for me" calls still work.
    const sourceQuizTargetStudent = studentId ?? userId;
    const testQuiz = await prisma.examPaper.create({
      data: {
        // Drop the "Test Quiz — " prefix; the student/parent should see
        // the original paper title (e.g. "PSLE English 2024") on their
        // dashboard, not "Test Quiz — PSLE English 2024". paperType
        // already distinguishes test quizzes from regular assignments
        // for any code that needs to.
        title: paper.title,
        subject: paper.subject,
        level: paper.level,
        userId,
        assignedToId: sourceQuizTargetStudent,
        ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
        paperType: "quiz",
        instantFeedback: true,
        // English + Chinese Test Quizzes are scan-back markable: the
        // parent can print → student writes on the paper → scan back.
        // For that path to work, the clone needs the master's
        // pageCount, original pageIndex per question, y/x bounds, AND
        // a sourceExamId so /print can fall back to the master's PDF
        // (or page JPEGs). Math/Science Test Quizzes are typed quizzes
        // marked via markQuizPaper; they keep the legacy
        // pageCount=0 + pageIndex=0 shape since their canvas reader
        // doesn't use these fields.
        ...((isEnglish || isChinese) ? { sourceExamId: paper.id, pageCount: paper.pageCount } : { pageCount: 0 }),
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        metadata: {
          quizType: oeqQs.length > 0 ? "mcq-oeq" : "mcq",
          ...(englishSectionsMeta ? { englishSections: englishSectionsMeta } : {}),
          ...(chineseSectionsMeta ? { chineseSections: chineseSectionsMeta } : {}),
          sourceLabels: Object.fromEntries(allQs.map((q, i) => [String(i + 1), [paper.year, paper.examType, paper.school].filter(Boolean).join(" ") || null])),
          // English/Chinese: inherit page-hide metadata so the marker's
          // submission-index map matches the master's print layout
          // (answer pages dropped, skip pages dropped). Chinese also
          // inherits the OEQ-pad page index range so the scan-back
          // marker knows the Q33-Q40 strips live on appended pages.
          ...((isEnglish || isChinese) ? {
            answerPages: (paper.metadata as { answerPages?: number[] } | null)?.answerPages ?? [],
            skipPages: (paper.metadata as { skipPages?: number[] } | null)?.skipPages ?? [],
          } : {}),
          ...(isChinese ? {
            normalExtractChinese: ((paper.metadata as { normalExtractChinese?: Record<string, unknown> } | null)?.normalExtractChinese ?? {}),
          } : {}),
        } as Prisma.InputJsonValue,
        questions: {
          create: allQs.map((q, i) => ({
            questionNum: String(i + 1),
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            marksAvailable: q.marksAvailable ?? 1,
            syllabusTopic: q.syllabusTopic,
            // English: preserve master pageIndex + bounds so the
            // scan-back marker can group + crop. Math/Science: keep
            // pageIndex=0 (canvas marker doesn't use it).
            ...(isEnglish ? {
              pageIndex: q.pageIndex,
              yStartPct: q.yStartPct,
              yEndPct: q.yEndPct,
              xStartPct: q.xStartPct,
              xEndPct: q.xEndPct,
            } : { pageIndex: 0 }),
            orderIndex: i,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? undefined,
            transcribedOptionImages: q.transcribedOptionImages ?? undefined,
            transcribedOptionTable: q.transcribedOptionTable ?? undefined,
            transcribedSubparts: q.transcribedSubparts ?? undefined,
            diagramImageData: q.diagramImageData,
            diagramBounds: q.diagramBounds ?? undefined,
            sourceQuestionId: q.id,
          })),
        },
      },
    });

    return NextResponse.json({ id: testQuiz.id, questionCount: allQs.length });
  }

  if (!userId || !quizType) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const targetStudentId = studentId || userId;

  // ── Chinese subject (admin-only) — pool Chinese masters and build
  // a Test Quiz from the selected sections. The dashboard's Chinese
  // checklist sends section labels that match chineseSections labels
  // on the master ("短文填空", "阅读理解 A", "阅读理解 B OEQ", …).
  // We pull the master's questions for those sections, copy the
  // passages over, and stamp chineseSections metadata on the new
  // paper so the quiz player picks up the section-aware layouts.
  if (subject === "chinese") {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, settings: true } });
    // Admin OR an entry in the Chinese-access allow-list passes.
    const { canAssignChinese } = await import("@/lib/chinese-access");
    if (!isAdmin(actor) && !canAssignChinese(actor?.name)) {
      return NextResponse.json({ error: "Chinese papers can only be assigned by an admin." }, { status: 403 });
    }
    // P4 and lower are blocked at launch — the Chinese bank only
    // covers P5/P6 today. The dashboard subject picker hides 华文
    // for these students; this is the API-side parity check so a
    // hand-crafted POST can't bypass it.
    const targetStudentLevel = await prisma.user.findUnique({
      where: { id: targetStudentId },
      select: { level: true },
    });
    if ((targetStudentLevel?.level ?? 99) <= 4) {
      return NextResponse.json({ error: "Chinese is currently available for P5 and P6 only." }, { status: 400 });
    }
    if (!chineseSections || chineseSections.length === 0) {
      return NextResponse.json({ error: "Pick at least one Chinese section." }, { status: 400 });
    }
    const wanted = new Set(chineseSections);
    // Resolve the target student's level so we only pick from masters
    // at that level. Without this filter the picker was sourcing P5
    // questions for P6 students because masters[] is newest-first and
    // P5 papers were uploaded more recently than P6 in this period.
    const targetStudent = await prisma.user.findUnique({
      where: { id: targetStudentId },
      select: { level: true },
    });
    const levelMap: Record<number, string> = { 3: "Primary 3", 4: "Primary 4", 5: "Primary 5", 6: "Primary 6" };
    const targetLevelStr = targetStudent?.level ? levelMap[targetStudent.level] : null;
    // Pull all uploaded Chinese masters (newest first), pool their
    // questions for the selected sections. `paperType: null` excludes
    // earlier Chinese Test Quizzes (paperType="quiz") from the pool —
    // without it the picker silently sourced questions from previously
    // generated test quizzes, and the resulting sourceQuestionId chain
    // had to be walked twice to reach the real master.
    const masters = await prisma.examPaper.findMany({
      where: {
        subject: { contains: "chinese", mode: "insensitive" },
        sourceExamId: null,
        paperType: null,
        extractionStatus: "ready",
        ...(targetLevelStr ? { level: targetLevelStr } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (masters.length === 0) {
      return NextResponse.json({ error: "No extracted Chinese master papers found." }, { status: 404 });
    }
    type MasterSec = { label: string; startIndex: number; endIndex: number; passage?: string };
    type PickedSec = MasterSec & { questions: typeof masters[0]["questions"]; sourcePaperId: string };
    // Canonical PSLE 华文 paper section order. Used both to sort the
    // wanted labels (so we pick one section at a time in the order the
    // student would meet them on the printed paper) and to re-order the
    // final pickedSections array (different sections may come from
    // different masters, so source iteration alone can't preserve order).
    const CANON_ORDER = ["语文应用 MCQ", "短文填空", "阅读理解 MCQ", "完成对话", "阅读理解 A", "阅读理解 B OEQ"];
    const canonIdx = (lbl: string) => {
      const i = CANON_ORDER.indexOf(lbl);
      return i >= 0 ? i : 99;
    };
    // Hard rule for the mixed-passage 阅读理解 A section: the modern
    // PSLE format pairs Q30-32 MCQ with one long 4-mark OEQ (Q33) on
    // the same passage, and the user-facing intent of picking "阅读理解
    // A" is to get that bundle. Older masters (e.g. PSLE 2016) split
    // the long OEQ into a separate "阅读理解 A OEQ" section, so picking
    // their "阅读理解 A" yields only the 4 MCQs — Q33 silently disappears.
    // Validate that the section's final question is OEQ-shaped before
    // accepting it; otherwise skip and try a different master.
    function isModernCompA(secQs: typeof masters[0]["questions"]): boolean {
      const last = secQs[secQs.length - 1];
      if (!last) return false;
      const lastIsOeq = !(Array.isArray(last.transcribedOptions) && last.transcribedOptions.length > 0);
      return lastIsOeq;
    }
    // Sort wanted labels into canonical order BEFORE picking, so each
    // section gets a single chance to find its best source master and
    // the resulting test quiz reads in paper order.
    const wantedOrdered = [...wanted].sort((a, b) => canonIdx(a) - canonIdx(b));
    const pickedSections: PickedSec[] = [];
    for (const label of wantedOrdered) {
      // Gather every master that carries this exact section label and
      // passes the per-label validation. masters[] is newest-first by
      // createdAt; once we have valid candidates we randomly pick one
      // for variety (re-running the same assignment shouldn't always
      // return the same paper's questions).
      type Cand = { master: typeof masters[0]; sec: MasterSec; secQs: typeof masters[0]["questions"] };
      const candidates: Cand[] = [];
      for (const master of masters) {
        const cs = (master.metadata as { chineseSections?: MasterSec[] } | null)?.chineseSections ?? [];
        for (const sec of cs) {
          if (sec.label !== label) continue;
          const secQs = master.questions.slice(sec.startIndex, sec.endIndex + 1);
          if (secQs.length === 0) continue;
          // 阅读理解 A must include the long OEQ (Q33) — see comment above.
          if (label === "阅读理解 A" && !isModernCompA(secQs)) continue;
          candidates.push({ master, sec, secQs });
        }
      }
      if (candidates.length === 0) continue;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      pickedSections.push({ ...pick.sec, questions: pick.secQs, sourcePaperId: pick.master.id });
    }
    if (pickedSections.length === 0) {
      return NextResponse.json({ error: "No matching sections found across the Chinese masters." }, { status: 404 });
    }
    // Build the flat question list and a fresh chineseSections array
    // with re-anchored indices into the test quiz's question pool.
    const allQs: typeof masters[0]["questions"] = [];
    const newChineseSections: MasterSec[] = [];
    for (const sec of pickedSections) {
      const startIndex = allQs.length;
      allQs.push(...sec.questions);
      newChineseSections.push({
        label: sec.label,
        startIndex,
        endIndex: startIndex + sec.questions.length - 1,
        ...(sec.passage ? { passage: sec.passage } : {}),
      });
    }
    const totalMarks = allQs.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
    const scheduledForDate2 = scheduledFor ? new Date(scheduledFor) : undefined;
    const titleLabel = newChineseSections.length === 1
      ? `Chinese — ${newChineseSections[0].label}`
      : `Chinese — ${newChineseSections.length} sections`;
    const testQuiz = await prisma.examPaper.create({
      data: {
        title: titleLabel,
        subject: "Chinese",
        // Stamp the clone with the TARGET STUDENT'S level (e.g.
        // "Primary 6"), not the picked master's level. Pre-fix the
        // clone inherited the first master's level which, combined
        // with the missing master-query level filter, surfaced as
        // "P6 student gets a P5-tagged Chinese quiz".
        level: targetLevelStr ?? masters[0].level,
        userId,
        assignedToId: targetStudentId,
        ...(scheduledForDate2 ? { scheduledFor: scheduledForDate2 } : {}),
        paperType: "quiz",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: {
          quizType: "mcq",
          chineseSections: newChineseSections,
        } as any,
        questions: {
          create: allQs.map((q, i) => ({
            questionNum: String(i + 1),
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            marksAvailable: q.marksAvailable ?? 1,
            syllabusTopic: q.syllabusTopic,
            pageIndex: 0,
            orderIndex: i,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? undefined,
            transcribedOptionImages: q.transcribedOptionImages ?? undefined,
            transcribedOptionTable: q.transcribedOptionTable ?? undefined,
            transcribedSubparts: q.transcribedSubparts ?? undefined,
            diagramImageData: q.diagramImageData,
            diagramBounds: q.diagramBounds ?? undefined,
            sourceQuestionId: q.id,
          })),
        },
      },
    });
    return NextResponse.json({ id: testQuiz.id, questionCount: allQs.length });
  }

  // Server-side idempotency check — if the same parent triggered the
  // same (subject, student, sections, scheduledFor) within the last
  // 90s, return the existing paper instead of creating a duplicate.
  // English quiz generation is slow (multiple seconds of cascading
  // findMany + backfill loops); if the parent switches tabs or
  // re-clicks before the first request resolves, we'd otherwise
  // create two papers.
  {
    const subj: string = subject ?? "";
    const dedupWindow = new Date(Date.now() - 90_000);
    const sectionFingerprint = subj === "english"
      ? (englishSections ?? []).slice().sort().join(",")
      : subj === "chinese"
        ? (chineseSections ?? []).slice().sort().join(",")
        : "";
    const subjectFilter: Record<string, unknown> =
      subj === "english" ? { subject: "English Language" }
      : subj === "chinese" ? { subject: "Chinese" }
      : subj === "math" ? { subject: { contains: "math", mode: "insensitive" } }
      : subj === "science" ? { subject: { contains: "science", mode: "insensitive" } }
      : {};
    const recent = await prisma.examPaper.findFirst({
      where: {
        userId,
        assignedToId: targetStudentId,
        paperType: focused ? "focused" : "quiz",
        createdAt: { gte: dedupWindow },
        ...(scheduledFor ? { scheduledFor: new Date(scheduledFor) } : {}),
        ...subjectFilter,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, metadata: true, questions: { select: { id: true } } },
    });
    if (recent) {
      // Compare section list on the matching paper's metadata. For
      // Math/Science we don't fingerprint sections, so any same-
      // (student, subject, scheduledFor) hit in the window is a dup.
      let isDuplicate: boolean;
      if (subj === "english" || subj === "chinese") {
        const meta = recent.metadata as { englishSections?: Array<{ label: string }>; chineseSections?: Array<{ label: string }> } | null;
        const recentSections = subj === "english"
          ? (meta?.englishSections ?? []).map(s => s.label).sort().join(",")
          : (meta?.chineseSections ?? []).map(s => s.label).sort().join(",");
        isDuplicate = recentSections === sectionFingerprint || (sectionFingerprint === "" && recentSections === "");
      } else {
        isDuplicate = true;
      }
      if (isDuplicate) {
        console.log(`[daily-quiz] dedup hit — returning existing paper ${recent.id} (within 90s window) for student=${targetStudentId} subject=${subj}`);
        return NextResponse.json({ id: recent.id, questionCount: recent.questions.length, dedup: true });
      }
    }
  }
  T.mark("dedup-check");

  // Get the student's level
  const student = await prisma.user.findUnique({
    where: { id: targetStudentId },
    select: { level: true, settings: true },
  });
  // P3 English isn't supported yet — refuse the request if a P3
  // student is targeted with subject=english. UI hides the option, so
  // this is a defensive guard.
  if (student?.level === 3 && subject === "english") {
    return NextResponse.json({ error: "Primary 3 English is not yet supported." }, { status: 400 });
  }
  // Revision mode: override the level + relax filters. Validated
  // against the student's actual level so a tampered request can't
  // pull, say, P1 questions for a P5 student. Must be at least 1
  // and strictly less than the student's level.
  const isRevision = typeof revisionLevel === "number"
    && Number.isInteger(revisionLevel)
    && revisionLevel >= 1
    && !!student?.level
    && revisionLevel < student.level;
  const effectiveLevel = isRevision ? revisionLevel : student?.level ?? null;
  const levelFilter = effectiveLevel ? `Primary ${effectiveLevel}` : undefined;
  // Parent setting: parents can opt out of AI-generated synthetic
  // variants. Default ON; only excluded when explicitly false.
  const includeAiQuestions = ((student?.settings as { includeAiQuestions?: unknown } | null)?.includeAiQuestions !== false);

  // Determine which exam types are appropriate based on current date
  // Jan - Apr 17: WA1 only | Apr 18 - Jul 14: WA1, WA2, SA1 | Jul 15 - Aug: WA1, WA2, WA3, SA1 | Sep-Dec: all
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentDay = now.getDate();
  let allowedExamTypes: string[] | null = null; // null = allow all
  if (currentMonth < 4 || (currentMonth === 4 && currentDay <= 17)) {
    allowedExamTypes = ["WA1"];
  } else if (currentMonth < 7 || (currentMonth === 7 && currentDay <= 14)) {
    allowedExamTypes = ["WA1", "WA2", "SA1"];  // SA1 covers WA1+WA2 scope
  } else if (currentMonth <= 8) {
    allowedExamTypes = ["WA1", "WA2", "WA3", "SA1"];
  }
  // Sep-Dec: all types allowed including SA2, Prelim, End of Year etc.

  // P6 from June 1st onwards: open the full bank (PSLE-bound, parents
  // want Prelim / PSLE / SA2 / EOY material on the daily quiz, not
  // WA1/WA2). PSLE is end-of-year for P6 — same bucket as "End of
  // Year". Mirrors the override in focused-test/route.ts.
  const isP6PostJune1 = student?.level === 6 && (currentMonth > 6 || (currentMonth === 6 && currentDay >= 1));
  if (isP6PostJune1) {
    allowedExamTypes = null;
  }

  // Revision-mode prefers full year-end papers — drop the time-of-year
  // gate and try EOY / Prelim / SA2 first.
  const REVISION_PREFERRED_EXAM_TYPES = ["EOY", "End of Year", "Prelim", "Preliminary", "SA2"];
  if (isRevision) {
    allowedExamTypes = REVISION_PREFERRED_EXAM_TYPES;
  }

  const subjectFilter = subject === "science" ? "science" : subject === "english" ? "english" : "math";

  // Source papers store level as "P5" / "Primary 5" / "5" inconsistently — accept all.
  const levelVariantsFor = (level: string | null | undefined): string[] | null => {
    if (!level) return null;
    const bare = level.replace(/^Primary\s+|^P/i, "").trim();
    return [`P${bare}`, `Primary ${bare}`, bare];
  };
  // Resolve the student's difficulty mode once per request and thread it
  // through questionWhere. Null primary = no difficulty filter (standard or
  // adaptive-unlocked).
  const rawDifficultyMode = await getStudentDifficultyMode(targetStudentId);
  const baseDifficultyFilter = await resolveDifficultyFilter(rawDifficultyMode, targetStudentId, subjectFilter);
  // Revision mode draws across all difficulties — the goal is broad
  // recap coverage, not the targeted level the parent picked.
  const difficultyFilter = isRevision
    ? { primary: null, fallback: null }
    : baseDifficultyFilter;

  const questionWhere = (lf: string | null, examTypeFilter: string[] | null, difficultyLevels: number[] | null, allowUnrated: boolean) => {
    // Difficulty bucket (strict by default; allow difficulty=null on
    // broadened/fallback passes only).
    const difficultyClause = difficultyLevels && difficultyLevels.length > 0
      ? (allowUnrated
        ? { OR: [{ difficulty: { in: difficultyLevels } }, { difficulty: null }] }
        : { difficulty: { in: difficultyLevels } })
      : null;
    // Time-of-year examType gate. Match either the bank paper's
    // examType (top-school sources) OR the question's
    // syntheticSourceExamType (synthetic-bank rows whose source paper
    // had that examType). This lets a synthetic question whose source
    // was a WA1 paper pass the WA1 gate even though its bank paper
    // sits under examType "Synthetic".
    const examTypeClause = examTypeFilter
      ? {
          OR: [
            { examPaper: { examType: { in: examTypeFilter } } },
            { syntheticSourceExamType: { in: examTypeFilter } },
          ],
        }
      : null;
    return {
      // Don't filter by transcribedStem — multi-part questions (e.g.
      // Q38a stem-only + Q38bc sub-parts) must be kept together for
      // mergeOeqGroup. Stem-less questions are filtered at the group
      // level.
      answer: { not: null as null },
      // Exclude topics MOE removed from the 2025/2026 PSLE syllabus
      // (Cells / Speed / Compass). Full-paper assignments still see
      // them; only quiz / focused-practice pools skip. See
      // src/lib/legacy-topics.ts for the policy.
      syllabusTopic: { notIn: [...LEGACY_TOPICS] },
      ...(difficultyClause ?? {}),
      ...(examTypeClause ?? {}),
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: subjectFilter, mode: "insensitive" as const },
        ...((() => {
          const v = levelVariantsFor(lf);
          return v ? { level: { in: v } } : {};
        })()),
        // Honour the parent's "Include AI generated questions" toggle.
        // AI variants live on synthetic-bank papers (examType
        // "Synthetic" + title prefix "[Synthetic Bank]"). When the
        // parent opts out, exclude both shapes — this rejects the
        // entire synthetic-bank paper before the OR-clause above can
        // pull rows in via syntheticSourceExamType.
        ...(includeAiQuestions ? {} : {
          NOT: [
            { examType: "Synthetic" },
            { title: { startsWith: "[Synthetic Bank]" } },
          ],
        }),
      },
    };
  };

  // Light select for pool building (excludes large blob fields)
  const questionSelectLight = {
    id: true,
    questionNum: true,
    examPaperId: true,
    answer: true,
    marksAvailable: true,
    syllabusTopic: true,
    pageIndex: true,
    transcribedStem: true,
    // transcribedSubparts INTENTIONALLY OMITTED — the `_passage`
    // subpart on cloze rows holds 1500-2000 char passage text, which
    // multiplies bulk-fetch wire size on English pools (4-5MB across
    // 2800 rows). Hydrated below for: (1) English passage-builder
    // firstQs before the loop, (2) Math/Science OEQ group members in
    // the existing oeq-diagram-hydrate fan-out, (3) final selected
    // questions via hydrateBlobs.
    transcribedOptions: true,
    transcribedOptionImages: true,
    transcribedOptionTable: true,
    // sourceQuestionId is the master a question was cloned from (or
    // null if it IS a master). Needed for the dedup pass in
    // buildPools so master + synthetic variants don't both surface.
    sourceQuestionId: true,
    // diagramImageData INTENTIONALLY OMITTED — pulling the base64
    // image blob for every row in a 700+ row pool was the bulk of
    // the 60-70s Math/Science assign time (38 MB+ over the wire).
    // mergeOeqGroup needs it for non-first OEQ members, so we hydrate
    // it separately for the selected ~15 questions just before merge.
    diagramBounds: true,
    examPaper: {
      select: { id: true, year: true, examType: true, school: true, pageCount: true },
    },
  };

  // Run both queries in parallel for speed
  // topicMatched is let because difficulty fallback may reassign it
  const [previousQuizQuestions, initialTopicMatched] = await Promise.all([
    // Get source question IDs already used in this student's previous quizzes
    prisma.examQuestion.findMany({
      where: {
        sourceQuestionId: { not: null },
        examPaper: { assignedToId: targetStudentId, paperType: "quiz" },
      },
      select: { sourceQuestionId: true },
    }),
    // Find all clean-extracted questions from master papers (matching level + semester)
    // Light query first (no blobs) — full data loaded later for selected questions only.
    // Primary pass is STRICT (no unrated) so the student's chosen difficulty
    // is honoured. Unrated questions and the fallback level only join in
    // later passes when the strict pool is too small.
    prisma.examQuestion.findMany({
      where: questionWhere(levelFilter ?? null, subject === "english" ? null : allowedExamTypes, difficultyFilter.primary, false),
      select: questionSelectLight,
    }),
  ]);
  let topicMatched = initialTopicMatched;
  T.mark(`pool-fetch (topicMatched=${initialTopicMatched.length})`);
  // Difficulty fallback ladder for non-standard modes:
  //   1. strict primary (e.g. Lv 1-3)  — already done above
  //   2. primary + unrated              — accept null difficulty
  //   3. primary + fallback (e.g. + Lv 4) + unrated
  // We never drop the difficulty cap entirely — for "easier"/"adaptive"
  // mode that would let a Lv 5 'Very Hard' question through, defeating
  // the whole point of the setting. Same for "hard": never let Lv 1-2
  // through.
  const TARGET_POOL = 30;
  const difficultyWarnings: string[] = [];
  if (difficultyFilter.primary && topicMatched.length < TARGET_POOL) {
    // Step 2: same levels but include unrated rows.
    const withNull = await prisma.examQuestion.findMany({
      where: questionWhere(levelFilter ?? null, subject === "english" ? null : allowedExamTypes, difficultyFilter.primary, true),
      select: questionSelectLight,
    });
    if (withNull.length > topicMatched.length) {
      topicMatched = withNull;
      difficultyWarnings.push(`Lv ${difficultyFilter.primary.join(",")} pool was thin — also drawing unrated questions.`);
    }
    // Step 3: add the fallback bucket (e.g. Lv 4 for easier mode), still
    // including unrated.
    if (topicMatched.length < TARGET_POOL && difficultyFilter.fallback) {
      const broadened = [...difficultyFilter.primary, ...difficultyFilter.fallback];
      const withFallback = await prisma.examQuestion.findMany({
        where: questionWhere(levelFilter ?? null, subject === "english" ? null : allowedExamTypes, broadened, true),
        select: questionSelectLight,
      });
      if (withFallback.length > topicMatched.length) {
        topicMatched = withFallback;
        difficultyWarnings.push(`Fell back from Lv ${difficultyFilter.primary.join(",")} to Lv ${broadened.join(",")} (incl. unrated) for this quiz.`);
      }
    }
    // No final 'drop all caps' pass — the cap is part of the contract
    // with the parent's setting.
  }
  if (difficultyWarnings.length > 0) {
    console.log(`[daily-quiz] student=${targetStudentId} subject=${subject}:`, difficultyWarnings.join(" · "));
  }

  // Revision-mode pool fallback: if the EOY/Prelim/SA2 pool from the
  // lower level is too small, broaden to ALL exam types so the parent
  // still gets a full quiz instead of a half-empty one.
  if (isRevision && topicMatched.length < TARGET_POOL) {
    const broadened = await prisma.examQuestion.findMany({
      where: questionWhere(levelFilter ?? null, null, null, true),
      select: questionSelectLight,
    });
    if (broadened.length > topicMatched.length) {
      topicMatched = broadened;
      console.log(`[daily-quiz] revision pool broadened from ${REVISION_PREFERRED_EXAM_TYPES.join("/")} to all exam types (P${effectiveLevel}, ${broadened.length} qs)`);
    }
  }
  const usedSourceIds = new Set(previousQuizQuestions.map(q => q.sourceQuestionId!));

  // Pull in every DB sibling for each (examPaperId, baseNum) in the
  // topic-matched set. Topic-tagged subparts often arrive without
  // their parent row, which may carry the lead stem / diagram.
  // Without this the group pool loses those hints.
  //
  // Previously this built a Postgres `OR` with up to N clauses (one
  // per distinct (paperId, baseNum) pair). At 100+ papers × 10
  // baseNums that's a 1000-clause OR — Postgres rejects sane plans
  // for those and falls back to a sequential scan. Now: collapse to
  // a single `examPaperId IN (...)` query and filter the resulting
  // rows in-memory by baseNum. ONE query, ONE plan.
  const baseNumOf = (n: string) => n.replace(/[a-zA-Z]+$/, "");
  const siblingKeys = new Set<string>();
  for (const q of topicMatched) siblingKeys.add(`${q.examPaperId}::${baseNumOf(q.questionNum)}`);
  const distinctPaperIds = [...new Set([...topicMatched].map(q => q.examPaperId))];
  const siblingsRaw = distinctPaperIds.length > 0
    ? await prisma.examQuestion.findMany({
        where: { examPaperId: { in: distinctPaperIds }, answer: { not: null } as { not: null } },
        select: questionSelectLight,
      })
    : [];
  const siblings = siblingsRaw.filter(q => siblingKeys.has(`${q.examPaperId}::${baseNumOf(q.questionNum)}`));
  T.mark(`siblings-query (papers=${distinctPaperIds.length} → rows=${siblingsRaw.length} → kept=${siblings.length})`);
  const qById = new Map<string, typeof topicMatched[number]>();
  for (const q of topicMatched) qById.set(q.id, q);
  for (const q of siblings) if (!qById.has(q.id)) qById.set(q.id, q);
  const allQuestions = [...qById.values()];

  // Q is the light-pool row. `diagramImageData` and `transcribedSubparts`
  // are no longer in the bulk select (both blow up wire size on large
  // pools — the diagram is a base64 blob, the subparts hold cloze
  // _passage strings 1500+ chars long on every row). Both are hydrated
  // lazily for the small set of selected questions that actually need
  // them (see oeq-member-hydrate for Math/Science and the firstQSubpartRows
  // fetch in the English passage builder). Keep them as optional on
  // the type so the existing code that reads them still compiles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Q = typeof allQuestions[number] & { diagramImageData?: string | null; transcribedSubparts?: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type FullQ = Q & { imageData: string | null; answerImageData: string | null; transcribedOptions: any; transcribedOptionImages: any; diagramImageData: string | null; transcribedSubparts: any };

  // Hydrate lightweight questions with large blob fields — only for the final selected set
  async function hydrateBlobs(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.examQuestion.findMany({
      where: { id: { in: ids } },
      select: { id: true, imageData: true, answerImageData: true, transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true, transcribedSubparts: true, diagramImageData: true },
    });
    return new Map(rows.map(r => [r.id, r]));
  }

  // Strip trailing letter(s) from a question number to get the base, e.g. "35ab" → "35", "35c" → "35", "12" → "12"
  function baseNum(questionNum: string) {
    return questionNum.replace(/[a-zA-Z]+$/, "");
  }

  // Normalise stems before dedup so trivial whitespace/punctuation/case
  // differences don't slip a duplicate through (a common cause: the
  // master and a re-extracted clone differ by a stray trailing space).
  function normStem(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  }

  function buildPools(questions: Q[]) {
    // ── MCQ pool: deduplicate by source AND by normalised stem ──────────
    // Source key catches master + its synthetic variants (synth carries
    // sourceQuestionId pointing to the master). Stem key catches questions
    // that share text but have no source link (e.g. two papers asking the
    // same question). Both together prevent the 'duplicate MCQ in one
    // quiz' bug the user hit when a master + its synthetic both made
    // it into the pool with slightly different stems.
    const mcqStemMap = new Map<string, Q>();
    const mcqSeenSources = new Set<string>();
    for (const q of questions) {
      if (!hasOptions(q)) continue;
      const stem = normStem(q.transcribedStem ?? "");
      if (!stem) continue;
      const sourceKey = q.sourceQuestionId ?? q.id;
      if (mcqSeenSources.has(sourceKey)) continue;
      if (mcqStemMap.has(stem)) continue;
      mcqSeenSources.add(sourceKey);
      mcqStemMap.set(stem, q);
    }

    // ── OEQ pool: group by (paperId, baseNum), deduplicate by lead stem ────
    // Include ALL questions in the group (even stem-less), since multi-part
    // questions like Q38a (stem-only) + Q38bc (sub-parts) must stay together.
    const oeqGroupMap = new Map<string, Q[]>();
    for (const q of questions) {
      if (hasOptions(q)) continue;
      const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
      if (!oeqGroupMap.has(key)) oeqGroupMap.set(key, []);
      oeqGroupMap.get(key)!.push(q);
    }
    for (const group of oeqGroupMap.values()) {
      group.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
    }
    const oeqLeadStemMap = new Map<string, Q[]>();
    const oeqSeenSources = new Set<string>();
    for (const group of oeqGroupMap.values()) {
      // Find lead stem from any member of the group (not just the first)
      const leadStemRaw = (group.find(q => (q.transcribedStem ?? "").trim())?.transcribedStem ?? "").trim();
      if (!leadStemRaw) continue; // Group has no stem at all — skip
      const leadStem = normStem(leadStemRaw);
      // Same source-key dedup as MCQ — catches groups whose lead member
      // is a synthetic of a master we've already kept.
      const sourceKey = group[0].sourceQuestionId ?? group[0].id;
      if (oeqSeenSources.has(sourceKey)) continue;
      if (oeqLeadStemMap.has(leadStem)) continue;
      oeqSeenSources.add(sourceKey);
      oeqLeadStemMap.set(leadStem, group);
    }

    return { mcqPool: [...mcqStemMap.values()], oeqPool: [...oeqLeadStemMap.values()] };
  }

  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);

  // ── ENGLISH QUIZ PATH ────────────────────────────────────────────────────
  if (subject === "english") {
    T.mark(`pre-english-path (allQuestions=${allQuestions.length})`);
    const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
    const freshQs = allQuestions.filter(q => !usedSourceIds.has(q.id));
    const usedQs = allQuestions.filter(q => usedSourceIds.has(q.id));
    // Cast through the Q-with-optionals alias so reads like
    // `firstQ.transcribedSubparts` later in the passage-build loop
    // compile — Q includes that field as optional even though we
    // omit it from the bulk select.
    const allPool: Q[] = [...freshQs, ...usedQs] as Q[]; // prefer fresh, fall back to used

    // Pool by syllabusTopic — match various naming patterns including "Section X: Grammar MCQ"
    // MCQ pools require a stem (or image) to display — exclude blank questions
    const hasStemOrImage = (q: Q) => !!(q.transcribedStem?.trim());
    const grammarMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "grammar" || t === "grammar mcq" || (t.includes("grammar") && !t.includes("cloze"))) && isMcq(q.answer) && hasStemOrImage(q);
    }));
    const vocabMcqPool = shuffle(allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t === "vocabulary" || t === "vocabulary mcq" || (t.includes("vocab") && !t.includes("cloze"))) && isMcq(q.answer) && hasStemOrImage(q);
    }));

    // Vocab Cloze MCQ: group by paper, then split each paper's set into 5-question
    // sub-passages. A single source paper often has TWO 5-question vocab cloze passages
    // (e.g. Q11-Q15 + Q16-Q20). Treating them as one 10-question set means the rendered
    // quiz mixes both passages without showing either one as context. Split by
    // question-number sequence so each sub-set maps to one passage.
    const vocabClozeAll = allPool.filter(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return (t.includes("vocabulary") && t.includes("cloze")) && isMcq(q.answer);
    });
    const vocabClozePaperGroups = new Map<string, typeof allPool>();
    for (const q of vocabClozeAll) {
      const key = q.examPaperId;
      if (!vocabClozePaperGroups.has(key)) vocabClozePaperGroups.set(key, []);
      vocabClozePaperGroups.get(key)!.push(q);
    }

    // Backfill each paper's vocab-cloze chunk with any sibling
    // questions from the master that didn't survive the allPool
    // filters (level / freshness / etc.). Passage-bound sections
    // are all-or-nothing — a 5-marker passage with only 4
    // questions in the pool would otherwise render the wrong
    // marker against the wrong word.
    // Parallel backfill — fire all per-paper sibling queries at once
    // and merge their results. Sequential await-in-for was the single
    // biggest cost in English quiz construction (8–10 papers × ~150ms
    // round-trip = 1.5s of pure latency that paralellises to ~150ms).
    {
      const entries = [...vocabClozePaperGroups.entries()];
      const results = await Promise.all(entries.map(([paperId, qs]) => {
        const haveIds = new Set(qs.map(q => q.id));
        return prisma.examQuestion.findMany({
          where: {
            examPaperId: paperId,
            answer: { not: null },
            syllabusTopic: { contains: "vocabulary", mode: "insensitive" },
            id: { notIn: [...haveIds] },
          },
          select: questionSelectLight,
        }).then(masterSiblings => ({ paperId, qs, masterSiblings }));
      }));
      for (const { paperId, qs, masterSiblings } of results) {
        const filtered = masterSiblings.filter((q) => {
          const t = (q.syllabusTopic ?? "").toLowerCase();
          return t.includes("vocabulary") && t.includes("cloze") && isMcq(q.answer);
        });
        if (filtered.length > 0) {
          vocabClozePaperGroups.set(paperId, [...qs, ...filtered]);
        }
      }
    }

    const vocabClozePapers = new Map<string, typeof allPool>();
    let vocabClozeSplitIdx = 0;
    for (const [paperId, qs] of vocabClozePaperGroups.entries()) {
      const sorted = [...qs].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
      const CHUNK = 5;
      if (sorted.length <= CHUNK) {
        vocabClozePapers.set(paperId, sorted);
        continue;
      }
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const chunk = sorted.slice(i, i + CHUNK);
        if (chunk.length > 0) {
          vocabClozePapers.set(`${paperId}#${vocabClozeSplitIdx++}`, chunk);
        }
      }
    }
    // Sort sets: all-fresh first, then partially fresh, then all-used
    const sortByFreshness = (sets: (typeof allPool)[]) => {
      return sets.sort((a, b) => {
        const aFresh = a.filter(q => !usedSourceIds.has(q.id)).length;
        const bFresh = b.filter(q => !usedSourceIds.has(q.id)).length;
        const aRatio = a.length > 0 ? aFresh / a.length : 0;
        const bRatio = b.length > 0 ? bFresh / b.length : 0;
        if (aRatio !== bRatio) return bRatio - aRatio; // more fresh first
        return Math.random() - 0.5; // shuffle within same freshness
      });
    };
    const vocabClozeSets = sortByFreshness([...vocabClozePapers.values()]);

    // Visual Text MCQ: group by paper
    const visualTextAll = allPool.filter(q => q.syllabusTopic?.toLowerCase().includes("visual") && q.syllabusTopic?.toLowerCase().includes("text") && isMcq(q.answer));
    const visualTextPapers = new Map<string, typeof allPool>();
    for (const q of visualTextAll) {
      const key = q.examPaperId;
      if (!visualTextPapers.has(key)) visualTextPapers.set(key, []);
      visualTextPapers.get(key)!.push(q);
    }
    const visualTextSets = sortByFreshness([...visualTextPapers.values()]);

    // Synthesis-focused practice stays pure: 10 P6 synthesis questions only,
    // no grammar/vocab MCQ bundled in.
    const isSynthesisFocus =
      isFocusedEnglish && englishSections?.length === 1 && englishSections[0] === "synthesis";
    // Select Grammar/Vocab MCQ based on user choices
    const selectedSections = new Set(englishSections ?? ["grammar-mcq", "vocab-mcq", "vocab-cloze"]);
    // Warn (not log) when a pool comes out empty — that's the only
    // case where the per-pool diagnostic detail is worth keeping. The
    // healthy-path "Pools:" / "Selected:" lines were noise.
    if (grammarMcqPool.length === 0 || vocabMcqPool.length === 0) {
      const grammarAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("grammar") && !(q.syllabusTopic ?? "").toLowerCase().includes("cloze"));
      const vocabAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("vocab") && !(q.syllabusTopic ?? "").toLowerCase().includes("cloze"));
      console.warn(`[English Quiz] empty pool — grammar candidates=${grammarAll.length} (MCQ=${grammarAll.filter(q => isMcq(q.answer)).length}), vocab candidates=${vocabAll.length} (MCQ=${vocabAll.filter(q => isMcq(q.answer)).length})`);
    }
    const mcqTake = isFocusedEnglish ? 10 : 5;
    const selectedGrammar = selectedSections.has("grammar-mcq") ? grammarMcqPool.slice(0, mcqTake) : [];
    const selectedVocab = selectedSections.has("vocab-mcq") ? vocabMcqPool.slice(0, mcqTake) : [];
    const selectedExtra: typeof allPool = [];
    const sectionLabels: Record<string, string> = {
      "vocab-cloze": "Vocab Cloze", "visual-text": "Visual Text",
      "grammar-cloze": "Grammar Cloze", "editing": "Editing",
      "comprehension-cloze": "Comprehension Cloze", "synthesis": "Synthesis",
      "comprehension-oeq": "Comprehension OEQ",
    };
    const activeLabels: string[] = [];
    // Track per-section question groups for section metadata
    const extraSectionGroups: Array<{ key: string; label: string; questions: typeof allPool }> = [];

    const topicMatchers: Record<string, (t: string) => boolean> = {
      "grammar-cloze": t => t.includes("grammar") && t.includes("cloze") && !t.includes("mcq"),
      "editing": t => t.includes("editing"),
      "comprehension-cloze": t => t.includes("comprehension") && t.includes("cloze"),
      "synthesis": t => t.includes("synthesis"),
      "comprehension-oeq": t => isCompOeqLabel(t),
    };

    // Fixed order: MCQ sections first (Vocab Cloze, Visual Text), then OEQ sections
    const sectionOrder = ["vocab-cloze", "visual-text", "grammar-cloze", "editing", "comprehension-cloze", "synthesis", "comprehension-oeq"];
    const orderedSections = sectionOrder.filter(s => selectedSections.has(s));

    // Sections that can be doubled by rendering TWO independent passages
    // (distinct paper sets) back-to-back in focused mode. Vocab / grammar /
    // comprehension cloze + editing + visual text all have "one passage + N
    // questions" structure, so each doubled section = 2 passages.
    const DOUBLABLE_PASSAGE_SECTIONS = new Set(["vocab-cloze", "grammar-cloze", "comprehension-cloze", "editing"]);

    const pushSectionGroup = (section: string, qs: typeof allPool, occurrence: number, total: number) => {
      if (qs.length === 0) return;
      // Sort by original question number so passage markers align
      const sorted = [...qs].sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
      const baseLabel = sectionLabels[section] ?? section;
      const label = total > 1 ? `${baseLabel} (${occurrence}/${total})` : baseLabel;
      selectedExtra.push(...sorted);
      activeLabels.push(label);
      extraSectionGroups.push({ key: section, label, questions: sorted });
    };

    for (const section of orderedSections) {
      // Visual text: 1 passage normally, 2 distinct passages in focused mode
      if (section === "visual-text") {
        const take = isFocusedEnglish && visualTextSets.length >= 2 ? 2 : Math.min(1, visualTextSets.length);
        for (let i = 0; i < take; i++) pushSectionGroup(section, visualTextSets[i], i + 1, take);
        continue;
      }
      // Vocab cloze: 2 distinct passage sets for focused practice
      if (section === "vocab-cloze") {
        const take = isFocusedEnglish && vocabClozeSets.length >= 2 ? 2 : Math.min(1, vocabClozeSets.length);
        for (let i = 0; i < take; i++) pushSectionGroup(section, vocabClozeSets[i], i + 1, take);
        continue;
      }
      // Synthesis: flat 10 questions (or 5 for non-focused), not passage-bound.
      // For synthesis-focused practice we deliberately pull from P6 only — that's
      // where the worthwhile synthesis transforms live; P5/P4 pools are thin.
      if (section === "synthesis") {
        let synthAll = allPool.filter(q => (q.syllabusTopic ?? "").toLowerCase().includes("synthesis"));
        if (isSynthesisFocus) {
          const p6Variants = ["P6", "Primary 6", "6"];
          const p6Synth = await prisma.examQuestion.findMany({
            where: {
              syllabusTopic: { contains: "synthesis", mode: "insensitive" },
              answer: { not: null as null },
              examPaper: {
                sourceExamId: null, paperType: null, visible: true,
                subject: { contains: "english", mode: "insensitive" },
                level: { in: p6Variants },
              },
            },
            select: questionSelectLight,
          });
          synthAll = p6Synth;
        }
        const synthFresh = shuffle(synthAll.filter(q => !usedSourceIds.has(q.id)));
        const synthUsed = shuffle(synthAll.filter(q => usedSourceIds.has(q.id)));
        pushSectionGroup(section, [...synthFresh, ...synthUsed].slice(0, isFocusedEnglish ? 10 : 5), 1, 1);
        continue;
      }
      // grammar-cloze, editing, comprehension-cloze, comprehension-oeq — passage-bound.
      const matcher = topicMatchers[section];
      if (!matcher) continue;
      const matchedQs = allPool.filter(q => matcher((q.syllabusTopic ?? "").toLowerCase()));
      const papersMap = new Map<string, typeof allPool>();
      for (const q of matchedQs) {
        if (!papersMap.has(q.examPaperId)) papersMap.set(q.examPaperId, []);
        papersMap.get(q.examPaperId)!.push(q);
      }

      // Backfill each paper's section chunk from master so every
      // passage-bound section renders with all its questions
      // present, even if individual questions failed the allPool
      // freshness / level filters. Same reasoning as the
      // vocab-cloze backfill above.
      //
      // Parallelised: the sequential await-in-for was the largest
      // single cost in English quiz construction. 4-6 sections × 5-8
      // papers × ~150ms each = 3-7s of pure latency that the
      // Promise.all collapses to one round-trip's worth.
      {
        const entries = [...papersMap.entries()];
        const results = await Promise.all(entries.map(([paperId, qs]) => {
          const haveIds = new Set(qs.map(q => q.id));
          return prisma.examQuestion.findMany({
            where: {
              examPaperId: paperId,
              answer: { not: null },
              id: { notIn: [...haveIds] },
            },
            select: questionSelectLight,
          }).then(siblings => ({ paperId, qs, siblings }));
        }));
        for (const { paperId, qs, siblings } of results) {
          const missing = siblings.filter((q) => matcher((q.syllabusTopic ?? "").toLowerCase()));
          if (missing.length > 0) {
            papersMap.set(paperId, [...qs, ...missing]);
          }
        }
      }

      const paperSets = sortByFreshness([...papersMap.values()]);
      if (paperSets.length === 0) continue;
      if (isFocusedEnglish && DOUBLABLE_PASSAGE_SECTIONS.has(section) && paperSets.length >= 2) {
        pushSectionGroup(section, paperSets[0], 1, 2);
        pushSectionGroup(section, paperSets[1], 2, 2);
      } else {
        // editing, comprehension-oeq, or only one paper available — single passage
        pushSectionGroup(section, paperSets[0], 1, 1);
      }
    }

    let allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];
    if (allSelected.length === 0) {
      return NextResponse.json({ error: "Not enough English questions available" }, { status: 404 });
    }
    T.mark(`english section-build (selected=${allSelected.length})`);

    // Pre-fetch all source paper metadata + transcribedSubparts for
    // each section's firstQ in parallel. The passage builder reads
    // firstQ.transcribedSubparts as a fallback when the paper meta
    // doesn't carry sectionOcrTexts (Comp OEQ `_passageText`). Pull
    // them now in ONE round-trip alongside the paper meta instead of
    // leaving them in the bulk pool select (where 2800 cloze rows
    // each carry 1500+ char _passage strings, dominating wire size).
    const sourcePaperIds = [...new Set(selectedExtra.map(q => q.examPaperId))];
    const firstQIds = [...new Set(extraSectionGroups.map(g => g.questions[0]?.id).filter((x): x is string => !!x))];
    const [sourcePapers, firstQSubpartRows] = await Promise.all([
      sourcePaperIds.length > 0
        ? prisma.examPaper.findMany({ where: { id: { in: sourcePaperIds } }, select: { id: true, metadata: true } })
        : Promise.resolve([]),
      firstQIds.length > 0
        ? prisma.examQuestion.findMany({ where: { id: { in: firstQIds } }, select: { id: true, transcribedSubparts: true } })
        : Promise.resolve([]),
    ]);
    const sourcePaperMap = new Map(sourcePapers.map(p => [p.id, p.metadata as { sectionOcrTexts?: Record<string, { ocrText: string }> } | null]));
    // Attach transcribedSubparts back onto each section's firstQ so
    // the passage-build loop's `firstQ.transcribedSubparts` access
    // still works.
    const subpartsById = new Map(firstQSubpartRows.map(r => [r.id, r.transcribedSubparts]));
    for (const g of extraSectionGroups) {
      const q = g.questions[0];
      if (q) (q as unknown as { transcribedSubparts?: unknown }).transcribedSubparts = subpartsById.get(q.id);
    }
    T.mark(`english sourcePapers-meta + firstQ-subparts (papers=${sourcePaperIds.length}, firstQs=${firstQIds.length})`);

    // Build section metadata for quiz display
    const sections: Array<{ label: string; startIndex: number; endIndex: number; passage?: string; sourceExamId?: string }> = [];
    let idx = 0;
    if (selectedGrammar.length > 0 || selectedVocab.length > 0) {
      sections.push({ label: "Section A: Grammar and Vocab MCQ", startIndex: idx, endIndex: idx + selectedGrammar.length + selectedVocab.length - 1 });
      idx += selectedGrammar.length + selectedVocab.length;
    }

    // For each extra section group, build section metadata with passage
    let sectionLetter = (selectedGrammar.length > 0 || selectedVocab.length > 0) ? "B" : "A";
    const sectionOcrNames: Record<string, string[]> = {
      "vocab-cloze": ["Vocabulary Cloze MCQ", "Vocabulary Cloze", "Vocab Cloze MCQ"],
      "visual-text": ["Visual Text Comprehension MCQ", "Visual Text MCQ", "Visual Text Comprehension"],
      "grammar-cloze": ["Grammar Cloze"],
      "editing": ["Editing", "Editing (Spelling & Grammar)", "Editing for Spelling and Grammar", "Editing (Spelling and Grammar)"],
      "comprehension-cloze": ["Comprehension Cloze"],
      "synthesis": ["Synthesis & Transformation", "Synthesis"],
      "comprehension-oeq": ["Comprehension OEQ", "Comprehension Open Ended", "Comprehension OE", "Comprehension (Open-ended)"],
    };

    for (const group of extraSectionGroups) {
      let passage: string | undefined;
      const firstQ = group.questions[0];

      if (firstQ) {
        // Try 1: transcribedSubparts sentinel (skip for Comp OEQ — _passage has question OCR, not reading passage)
        if (group.key !== "comprehension-oeq") {
          const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }> | null;
          const passageSub = subs?.find(s => s.label === "_passage");
          if (passageSub) { passage = passageSub.text; }
        }

        // Try 2: source paper's sectionOcrTexts (pre-fetched batch)
        // Skip for sections that don't use inline passage markers
        const skipOcrLookup = group.key === "visual-text" || group.key === "synthesis";
        // Comprehension OEQ: load the reading passage (passageOcrText), not the question OCR
        if (!passage && group.key === "comprehension-oeq") {
          const meta = sourcePaperMap.get(firstQ.examPaperId);
          if (meta?.sectionOcrTexts) {
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              if (isCompOeqLabel(secName)) {
                const fullData = secData as Record<string, unknown>;
                const passageText = fullData.passageOcrText as string | undefined;
                if (passageText) passage = passageText;
                break;
              }
            }
          }
          // Fallback: try loading from question's transcribedSubparts (_passageText)
          if (!passage && firstQ.transcribedSubparts) {
            const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }>;
            const passageSub = subs.find(s => s.label === "_passageText");
            if (passageSub) passage = passageSub.text;
          }
          // Last-resort fallback: older masters (P4 EOY Nan Hua 2025
          // and similar) put the reading passage under the _passage
          // sentinel, before the convention was tightened to "_passage
          // = question OCR, _passageText = reading passage". A short
          // _passage (< ~300c) is question OCR — skip. A long one
          // (≥ 500c) is the reading passage — use it. The threshold
          // is a heuristic; reading passages in PSLE / P5-P6 papers
          // are reliably 1000c+, while question-OCR sentinels are
          // single sentences.
          if (!passage && firstQ.transcribedSubparts) {
            const subs = firstQ.transcribedSubparts as Array<{ label: string; text: string }>;
            const passageSub = subs.find(s => s.label === "_passage");
            if (passageSub && (passageSub.text ?? "").length >= 500) passage = passageSub.text;
          }
        }
        if (!passage && !skipOcrLookup && group.key !== "comprehension-oeq") {
          const meta = sourcePaperMap.get(firstQ.examPaperId);
          if (meta?.sectionOcrTexts) {
            // Try exact name match first
            for (const name of (sectionOcrNames[group.key] ?? [])) {
              if (meta.sectionOcrTexts[name]) { passage = meta.sectionOcrTexts[name].ocrText; break; }
            }
            // Fuzzy fallback: match by key words
            if (!passage) {
              const keyWords: Record<string, string[]> = {
                "grammar-cloze": ["grammar", "cloze"],
                "editing": ["editing"],
                "comprehension-cloze": ["comprehension", "cloze"],
                "vocab-cloze": ["vocab", "cloze"],
                "synthesis": ["synthesis"],
                "comprehension-oeq": ["comprehension", "open"],
              };
              const words = keyWords[group.key] ?? [];
              if (words.length > 0) {
                for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
                  const nameLower = secName.toLowerCase();
                  if (words.every(w => nameLower.includes(w))) {
                    passage = secData.ocrText;
                    break;
                  }
                }
              }
            }
          }
        }

        // Try 3: Visual Text — compute passage page indices from source paper
        if (group.key === "visual-text" && !passage) {
          const sourcePaperId = firstQ.examPaperId;
          // First try sectionOcrTexts.passagePageIndices
          const meta = sourcePaperMap.get(sourcePaperId);
          if (meta?.sectionOcrTexts) {
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              if (secName.toLowerCase().includes("visual") && secName.toLowerCase().includes("text")) {
                const pageIndices = (secData as { passagePageIndices?: number[] }).passagePageIndices;
                if (pageIndices?.length) {
                  passage = `[VISUAL_PAGES:${sourcePaperId}:${pageIndices.join(",")}]`;
                }
                break;
              }
            }
          }

          // Fallback: compute visual text context pages from ALL source paper questions
          if (!passage) {
            try {
              const sourcePaperQuestions = await prisma.examQuestion.findMany({
                where: { examPaperId: sourcePaperId },
                select: { pageIndex: true, syllabusTopic: true, questionNum: true },
                orderBy: { orderIndex: "asc" },
              });
              const vtQs = sourcePaperQuestions.filter(q =>
                (q.syllabusTopic ?? "").toLowerCase().includes("visual") && (q.syllabusTopic ?? "").toLowerCase().includes("text")
              );
              const nonVtQs = sourcePaperQuestions.filter(q =>
                !((q.syllabusTopic ?? "").toLowerCase().includes("visual") && (q.syllabusTopic ?? "").toLowerCase().includes("text"))
              );

              if (vtQs.length > 0 && nonVtQs.length > 0) {
                const vtPages = new Set(vtQs.map(q => q.pageIndex));
                const nonVtPages = new Set(nonVtQs.map(q => q.pageIndex));
                const lastNonVtPage = Math.max(...nonVtPages);
                const firstVtPage = Math.min(...vtPages);
                const totalPages = (firstQ as any).examPaper?.pageCount ?? 0;
                const contextPages: number[] = [];
                for (let p = lastNonVtPage + 1; p < firstVtPage && p < totalPages; p++) {
                  contextPages.push(p);
                }
                // If no context pages found, use the VT question pages themselves
                const pagesToUse = contextPages.length > 0 ? contextPages : [...vtPages].sort((a, b) => a - b);
                passage = `[VISUAL_PAGES:${sourcePaperId}:${pagesToUse.join(",")}]`;
              } else if (vtQs.length > 0) {
                // No non-VT questions, use VT question pages
                const vtPages = [...new Set(vtQs.map(q => q.pageIndex))].sort((a, b) => a - b);
                passage = `[VISUAL_PAGES:${sourcePaperId}:${vtPages.join(",")}]`;
              }
            } catch (err) {
              console.warn(`[English Quiz] Visual Text: failed to compute context pages:`, err);
            }
          }

          if (!passage) {
            console.warn(`[English Quiz] Visual Text: all methods failed, using VISUAL_TEXT_SOURCE fallback`);
            passage = `[VISUAL_TEXT_SOURCE:${sourcePaperId}]`;
          }
        }
      }

      // For vocab cloze sets that came from a paper with multiple passages, narrow
      // the passage text to just the paragraph(s) containing this chunk's question
      // numbers. The full sectionOcrText holds both passages, so without this trim
      // both groups would render the same combined passage.
      if (passage && !passage.startsWith("[") && group.key === "vocab-cloze") {
        const targetNums = new Set(group.questions.map(q => parseInt(q.questionNum)).filter(n => !isNaN(n)));
        if (targetNums.size > 0) {
          const allMk: { num: number; index: number; end: number }[] = [];
          const re = /\*\*\((\d+)\)[^*]*\*\*/g;
          let mk;
          while ((mk = re.exec(passage)) !== null) {
            allMk.push({ num: parseInt(mk[1]), index: mk.index, end: mk.index + mk[0].length });
          }
          const inChunk = allMk.filter(m => targetNums.has(m.num));
          if (inChunk.length > 0 && inChunk.length < allMk.length) {
            // Walk to the nearest paragraph boundary on either side of the chunk's markers
            const first = inChunk[0].index;
            const last = inChunk[inChunk.length - 1].end;
            let start = passage.lastIndexOf("\n\n", first);
            start = start < 0 ? 0 : start + 2;
            let endNl = passage.indexOf("\n\n", last);
            if (endNl < 0) endNl = passage.length;
            passage = passage.slice(start, endNl).trim();
          }
        }
      }

      // Clean passage: keep only the first N markers, truncate after the last one.
      // Also handle the inverse case — if the passage has FEWER markers than questions
      // (e.g. OCR missed half the blanks, or the question list was over-merged), trim
      // the question list down so each rendered question lines up with a real blank.
      if (passage && !passage.startsWith("[")) {
        const qCount = group.questions.length;
        const usesInlineMarkersHere = ["grammar-cloze", "editing", "comprehension-cloze", "vocab-cloze"].includes(group.key);
        const allMarkers: { num: number; fullMatch: string; index: number }[] = [];
        const markerRegex = /\*\*\((\d+)\)[^*]*\*\*/g;
        let mm;
        while ((mm = markerRegex.exec(passage)) !== null) {
          allMarkers.push({ num: parseInt(mm[1]), fullMatch: mm[0], index: mm.index });
        }
        if (allMarkers.length > qCount) {
          // Passage has more markers than selected questions. The
          // *which* matters: when the daily-quiz selection drops a
          // master question from the middle of a section (e.g.
          // master Q18 of a 5-question vocab cloze isn't sampled),
          // truncating to the first N markers is wrong — it keeps
          // the dropped marker AND drops the kept-tail one. The
          // observed bug: master Qs 16-20 selected as 16/17/19/20,
          // truncate-to-first-4 kept markers 16/17/18/19 and
          // dropped 20 (the "indigenous" sentence).
          //
          // Surgical fix: identify markers that DON'T correspond
          // to a selected question and splice them out, leaving
          // only the ones that match. Renumbering below then maps
          // those to (1)..(N) in selection order. Falls back to
          // the original truncate-to-first-N behaviour if we
          // can't match selected master questionNums to markers.
          const selectedNums = new Set(group.questions.map(q => parseInt(q.questionNum)).filter(n => !isNaN(n)));
          const matchableMarkers = allMarkers.filter(m => selectedNums.has(m.num));
          if (selectedNums.size === qCount && matchableMarkers.length === qCount) {
            // Iterate in reverse so earlier indices stay valid as
            // we splice. Removing a marker also has to drop the
            // bold-emphasis closing **, which is part of fullMatch.
            let removed = 0;
            for (let i = allMarkers.length - 1; i >= 0; i--) {
              const m = allMarkers[i];
              if (selectedNums.has(m.num)) continue;
              passage = passage.slice(0, m.index) + passage.slice(m.index + m.fullMatch.length);
              removed++;
            }
          } else {
            const lastKept = allMarkers[qCount - 1];
            const cutPoint = lastKept.index + lastKept.fullMatch.length;
            const nextNewline = passage.indexOf("\n", cutPoint);
            passage = passage.slice(0, nextNewline >= 0 ? nextNewline : cutPoint).trimEnd();
          }
        } else if (usesInlineMarkersHere && allMarkers.length > 0 && allMarkers.length < qCount) {
          // Passage has too few markers — trim the questions to match so we don't end
          // up rendering 10 questions next to a passage with only 5 blanks.
          const drop = group.questions.slice(allMarkers.length);
          group.questions = group.questions.slice(0, allMarkers.length);
          const dropIds = new Set(drop.map(q => q.id));
          for (let i = selectedExtra.length - 1; i >= 0; i--) {
            if (dropIds.has(selectedExtra[i].id)) selectedExtra.splice(i, 1);
          }
          console.warn(`[English Quiz] ${group.label}: trimmed ${drop.length} questions to match passage marker count (${allMarkers.length} markers, was ${qCount} questions)`);
        }

        // Rewrite remaining markers to match quiz numbering (position-based)
        let markerIdx = 0;
        passage = passage.replace(/\*\*\((\d+)\)/g, () => {
          const quizNum = idx + markerIdx + 1;
          markerIdx++;
          return `**(${quizNum})`;
        });
      }

      sections.push({
        label: `Section ${sectionLetter}: ${group.label}`,
        startIndex: idx,
        endIndex: idx + group.questions.length - 1,
        ...(passage ? { passage } : {}),
      });
      // Only warn on the unhealthy case: a marker/question mismatch
      // for an inline-marker section. The happy-path per-section trace
      // wasn't actionable.
      const usesInlineMarkers = ["grammar-cloze", "editing", "comprehension-cloze", "vocab-cloze"].includes(group.key);
      if (passage && !passage.startsWith("[") && usesInlineMarkers) {
        const markerCount = (passage.match(/\*\*\(\d+\)/g) ?? []).length;
        if (markerCount !== group.questions.length) {
          const markers = [...passage.matchAll(/\*\*\((\d+)\)/g)].map(m => m[1]);
          console.warn(`[English Quiz] ${group.label}: passage has ${markerCount} markers but section has ${group.questions.length} questions (markers=[${markers.join(", ")}], qNums=[${group.questions.map(q => q.questionNum).join(", ")}])`);
        }
      }
      idx += group.questions.length;
      sectionLetter = String.fromCharCode(sectionLetter.charCodeAt(0) + 1);
    }

    // Rebuild allSelected after any in-loop trimming so we don't try to create quiz
    // questions for IDs that were dropped to match the passage marker count.
    allSelected = [...selectedGrammar, ...selectedVocab, ...selectedExtra];
    T.mark(`english passage-loop done (sections=${extraSectionGroups.length})`);

    // Hydrate selected questions with blob data
    const blobMap = await hydrateBlobs(allSelected.map(q => q.id));
    const allSelectedFull = allSelected.map(q => ({ ...q, ...blobMap.get(q.id) })) as FullQ[];
    T.mark(`english hydrateBlobs (ids=${allSelected.length})`);

    // Use the SAME marksAvailable fallback that question creation uses below, so
    // paper.totalMarks matches the sum of per-question marksAvailable. Otherwise a
    // synthesis question with null marksAvailable ends up counted as 1 here and 2
    // there, and the student's percentage can go above 100%.
    const resolveMarks = (q: FullQ) => q.marksAvailable ?? ((q.syllabusTopic ?? "").toLowerCase().includes("synthesis") ? 2 : 1);
    const totalMarks = allSelectedFull.reduce((sum, q) => sum + resolveMarks(q), 0);
    // Title-level labelling. In revision mode use the effective
    // (lower) level instead of the student's actual level — the
    // parent dashboard should show "P5 Revision …" for a P6 student
    // revising P5, not "P6 …".
    const titleLevel = effectiveLevel ?? student?.level ?? null;
    const levelLabel = titleLevel ? `P${titleLevel} ` : "";
    const revisionLabel = isRevision ? "Revision " : "";
    // Check if any non-MCQ sections are included
    const hasOeq = selectedExtra.some(q => {
      const t = (q.syllabusTopic ?? "").toLowerCase();
      return t.includes("editing") || t.includes("cloze") || t.includes("synthesis") || t.includes("comprehension");
    });
    const engQuizType = hasOeq ? "MCQ + OEQ" : "MCQ";

    // Short section labels for the weekly-calendar title. Kept concise so the
    // title fits inside the day card without overflow.
    const shortSectionLabels: Record<string, string> = {
      "grammar-mcq": "Grammar MCQ",
      "vocab-mcq": "Vocab MCQ",
      "vocab-cloze": "Vocab Cloze",
      "visual-text": "Visual Text",
      "grammar-cloze": "Grammar Cloze",
      "editing": "Editing",
      "comprehension-cloze": "Compre Cloze",
      "synthesis": "Synthesis",
      "comprehension-oeq": "Compre OEQ",
    };
    const selectedSectionKeys = englishSections ?? [];
    const firstShort = selectedSectionKeys.length > 0
      ? (shortSectionLabels[selectedSectionKeys[0]] ?? selectedSectionKeys[0])
      : null;
    const extraMarker = selectedSectionKeys.length > 1 ? "+" : "";

    // Focused English: title by the selected section, e.g. "P5 Focus: Grammar Cloze"
    let engTitle: string;
    if (isFocusedEnglish && (englishSections?.length ?? 0) === 1) {
      const secKey = englishSections![0];
      const secLabel = sectionLabels[secKey] ?? secKey;
      const kind = isRevision ? "Revision" : "Focus";
      engTitle = `${levelLabel}${kind}: ${secLabel}`;
    } else if (firstShort) {
      // Daily English quiz: show the first selected section, with '+' if there are more.
      engTitle = `${levelLabel}${revisionLabel}${firstShort}${extraMarker}`;
    } else {
      engTitle = `${levelLabel}${revisionLabel}English Quiz ${engQuizType}`;
    }

    const paper = await prisma.examPaper.create({
      data: {
        title: engTitle,
        subject: "English Language",
        // levelFilter already reflects the effective (revision) level
        // — set above when isRevision flipped the level filter.
        level: levelFilter || null,
        userId,
        assignedToId: targetStudentId,
        // Prisma schema defaults visible to false. Daily quizzes
        // MUST be visible so the assignee can open them — without
        // this the kid sees "quiz not found" on
        // /quiz/[id]?userId=... despite the paper existing.
        visible: true,
        ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
        paperType: isFocusedEnglish ? "focused" : "quiz",
        instantFeedback: true,
        pageCount: 0,
        extractionStatus: "ready",
        totalMarks: String(totalMarks),
        metadata: {
          quizType: "mcq",
          englishSections: sections,
          sourceLabels: Object.fromEntries(
            allSelectedFull.map((q, i) => {
              const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
              return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
            })
          ),
        },
        questions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: allSelectedFull.map((q, i) => ({
            questionNum: String(i + 1),
            imageData: q.imageData,
            answer: q.answer,
            answerImageData: q.answerImageData,
            marksAvailable: resolveMarks(q),
            syllabusTopic: q.syllabusTopic,
            pageIndex: 0,
            orderIndex: i,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions ?? undefined,
            transcribedOptionImages: q.transcribedOptionImages ?? undefined,
            transcribedOptionTable: q.transcribedOptionTable ?? undefined,
            transcribedSubparts: q.transcribedSubparts ?? undefined,
            diagramImageData: q.diagramImageData,
            diagramBounds: q.diagramBounds ?? undefined,
            sourceQuestionId: q.id,
          })) as any,
        },
      },
    });

    T.mark(`english paper.create (qs=${allSelected.length}, total=${T.total()}ms)`);
    return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
  }

  // ── MATH / SCIENCE QUIZ PATH ───────────────────────────────────────────
  // Build pools from ALL questions first so multi-part OEQ groups (e.g. 6ab + 6c)
  // stay together. Then split into fresh/used at the pool level.
  const { mcqPool: allMcqPool, oeqPool: allOeqPool } = buildPools(allQuestions);
  T.mark(`buildPools math/science (allQuestions=${allQuestions.length} → mcq=${allMcqPool.length} oeq=${allOeqPool.length})`);
  // MCQ: single question per pool entry
  const mcqFresh = allMcqPool.filter(q => !usedSourceIds.has(q.id));
  const mcqUsed  = allMcqPool.filter(q =>  usedSourceIds.has(q.id));
  // OEQ: group is "fresh" only if NO question in the group has been used
  const oeqFresh = allOeqPool.filter(g => !g.some(q => usedSourceIds.has(q.id)));
  const oeqUsed  = allOeqPool.filter(g =>  g.some(q => usedSourceIds.has(q.id)));
  shuffle(mcqFresh); shuffle(oeqFresh);
  shuffle(mcqUsed);  shuffle(oeqUsed);

  // Daily MCQ quiz lands at 15 questions — long enough to give the
  // marker meaningful signal, short enough that the kid actually
  // finishes in a sitting. Mixed mcq+oeq quizzes still pull 10 MCQ
  // + 5 OEQ (15 total) so neither path balloons. Onboarding kept
  // the 15 cap from before; the regular path now matches it.
  const baseMcqTarget = quizType === "mcq" ? 15 : 10;
  const mcqTarget = baseMcqTarget;
  const oeqTarget = 5;

  // Top up from level-1 if current level doesn't have enough fresh questions
  let mcqFreshPool = mcqFresh;
  let oeqFreshPool = oeqFresh;
  let mcqUsedPool  = mcqUsed;
  let oeqUsedPool  = oeqUsed;

  if (student?.level && student.level > 1 && (mcqFreshPool.length < mcqTarget || oeqFreshPool.length < oeqTarget)) {
    const prevLevelFilter = `Primary ${student.level - 1}`;
    const prevLevelQuestions = await prisma.examQuestion.findMany({
      // Prior-level top-up STILL respects the student's difficulty cap.
      // The earlier behaviour ignored it ('we're already stretching'),
      // which let a Lv 5 question from the prior level land in a quiz
      // the parent had set to 'progressive' — defeating the setting.
      // Use the broadened bucket (primary + fallback + unrated) so the
      // top-up doesn't completely zero out, while honouring the cap.
      where: questionWhere(
        prevLevelFilter,
        null,
        difficultyFilter.primary
          ? [...difficultyFilter.primary, ...(difficultyFilter.fallback ?? [])]
          : null,
        true,
      ),
      select: questionSelectLight,
    });
    const { mcqPool: allPrevMcq, oeqPool: allPrevOeq } = buildPools(prevLevelQuestions);
    const mcqPF = allPrevMcq.filter(q => !usedSourceIds.has(q.id));
    const mcqPU = allPrevMcq.filter(q =>  usedSourceIds.has(q.id));
    const oeqPF = allPrevOeq.filter(g => !g.some(q => usedSourceIds.has(q.id)));
    const oeqPU = allPrevOeq.filter(g =>  g.some(q => usedSourceIds.has(q.id)));
    shuffle(mcqPF); shuffle(oeqPF);
    shuffle(mcqPU); shuffle(oeqPU);
    mcqFreshPool = [...mcqFreshPool, ...mcqPF];
    oeqFreshPool = [...oeqFreshPool, ...oeqPF];
    mcqUsedPool  = [...mcqUsedPool,  ...mcqPU];
    oeqUsedPool  = [...oeqUsedPool,  ...oeqPU];
  }

  // Use fresh questions first; fall back to previously-seen ones if pool is exhausted
  const mcqPool = mcqFreshPool.length >= mcqTarget
    ? mcqFreshPool
    : [...mcqFreshPool, ...mcqUsedPool];
  const oeqPool = oeqFreshPool.length >= oeqTarget
    ? oeqFreshPool
    : [...oeqFreshPool, ...oeqUsedPool];

  function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!answer || !answer.trim()) return result;
    // Accept single-letter labels (a, b, c) AND roman-nested labels like
    // (ai), (aii), (bii), (civ). Matches the widened pattern in lib/marking.ts.
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

  // Merge a group of OEQ question records into one combined question for the quiz
  function mergeOeqGroup(group: Q[]) {
    const first = group[0];
    // Combine all subparts across parts, stripping sentinel entries
    type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };
    // The first sibling's stem is the main stem. Later siblings (e.g. Q38cd
    // "Xiao Ming noticed the inner surface… was wet") carry ADDITIONAL
    // scenario context that applies to their own subparts only — it must be
    // preserved or the student sees the later parts with no lead-in. Prepend
    // any different later stem to that sibling's first real subpart text.
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
    // Collect sentinels from all parts
    const sentinels: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      sentinels.push(...subs.filter(s => s.label.startsWith("_")));
    }
    // Use ONLY the first group member's stem as the main question stem.
    // Later parts (e.g. Q12c added context "Reflective strips...") have their
    // own scenario text that belongs to that subpart, not the main stem.
    // That context is prepended to the subpart's text below.
    const firstStem = (group.find(q => (q.transcribedStem ?? "").trim())?.transcribedStem ?? "").trim();
    const combinedStem = firstStem;

    // Use the first question's diagram, or fall back to any later question's diagram
    const diagramImageData = first.diagramImageData
      || group.find(q => q.diagramImageData)?.diagramImageData
      || null;

    // Combine answers, prefixing with subpart labels when missing.
    // E.g. Q7ab answer = "(a) 12 (b) 25" already has labels, but
    // Q7c answer = "50" needs "(c) " prepended so the review page can parse it.
    const answerParts: string[] = [];
    for (const q of group) {
      const ans = (q.answer ?? "").trim();
      if (!ans) continue;
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      // If this member has exactly one real subpart and the answer doesn't already
      // contain its label prefix, add it
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

    // Dedupe subparts by label — if multiple group members share the same label,
    // keep the first occurrence (which carries the diagram if any was attached).
    const seenLabels = new Set<string>();
    const uniqueSubparts: Subpart[] = [];
    for (const sp of allSubparts) {
      const key = sp.label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      uniqueSubparts.push(sp);
    }

    // Attach per-part answer text to each subpart (from any sibling that holds it).
    // This lets the marking prompt show the AI exactly which answer belongs to each part.
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
    // Note: answerImageData is added later via hydration by first.id. The marking-time
    // sync in marking.ts re-fetches all siblings and picks the right answer image then.

    return {
      ...first,
      answer: combinedAnswer || first.answer,
      transcribedStem: combinedStem,
      // Preserve sentinels (like _drawable) even when there are no real sub-parts —
      // otherwise a single-part OEQ with a drawable diagram loses its canvas background.
      transcribedSubparts: (enrichedSubparts.length > 0 || sentinels.length > 0)
        ? [...enrichedSubparts, ...sentinels]
        : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData,
    };
  }

  type MergedQ = ReturnType<typeof mergeOeqGroup>;
  let selectedMcq: Q[];
  let selectedOeq: MergedQ[];

  // Onboarding-diagnostic (firstQuiz=true) picks stratified across
  // the top-5 topics present in the available pool for this subject/
  // level. Random draw scatters too thin — e.g. 6 Geometry + 1 each
  // of 7 other topics falls below the Lumi chart's 3-attempt render
  // threshold (progress/[studentId]/page.tsx#L728), so only one bar
  // showed. Stratifying guarantees ≥3 attempts on ≥5 topics.
  //
  // We pick the 5 largest topic buckets in the pool (rather than a
  // fixed top-5 list) because DB labels don't cleanly map to the
  // PSLE-syllabus semantic groups — a fixed list silently falls
  // through to backfill and defeats the point.
  function pickStratifiedMcq(pool: Q[], perTopic: number, total: number): Q[] {
    const byTopic = new Map<string, Q[]>();
    for (const q of pool) {
      const t = (q.syllabusTopic ?? "").trim() || "(untagged)";
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t)!.push(q);
    }
    // Sort topic buckets by size descending, ignore "(untagged)" so
    // the chart doesn't get a nameless slice.
    const orderedTopics = [...byTopic.entries()]
      .filter(([t]) => t !== "(untagged)")
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t]) => t);
    const nTopics = Math.min(orderedTopics.length, Math.ceil(total / perTopic));
    const picked: Q[] = [];
    const seenIds = new Set<string>();
    for (const topic of orderedTopics.slice(0, nTopics)) {
      const bucket = byTopic.get(topic) ?? [];
      for (const q of bucket.slice(0, perTopic)) {
        if (!seenIds.has(q.id) && picked.length < total) {
          picked.push(q); seenIds.add(q.id);
        }
      }
    }
    // Backfill from the rest of the pool if any bucket was short.
    if (picked.length < total) {
      for (const q of pool) {
        if (picked.length >= total) break;
        if (!seenIds.has(q.id)) { picked.push(q); seenIds.add(q.id); }
      }
    }
    return picked.slice(0, total);
  }
  const subjLc = (subject ?? "").toLowerCase();
  const useStratified = firstQuiz && (subjLc.includes("math") || subjLc.includes("science"));

  if (quizType === "mcq") {
    if (mcqPool.length < 1) {
      return NextResponse.json({ error: "Not enough MCQ questions available" }, { status: 404 });
    }
    selectedMcq = useStratified
      ? pickStratifiedMcq(mcqPool, 3, 15)
      : mcqPool.slice(0, 15);
    selectedOeq = [];
  } else {
    if (mcqPool.length < 1 && oeqPool.length < 1) {
      return NextResponse.json({ error: "Not enough questions available" }, { status: 404 });
    }
    selectedMcq = useStratified
      ? pickStratifiedMcq(mcqPool, 2, 10)
      : mcqPool.slice(0, 10);
    // Targeted hydrate for selected OEQ groups. mergeOeqGroup reads
    // both `diagramImageData` (for refImageBase64 on sub-parts) and
    // `transcribedSubparts` (for the actual sub-part list) — neither
    // is in questionSelectLight anymore, so we pull them in one
    // findMany for the ≤ 5 groups × ~3 members = 15 ids max.
    const oeqGroups = oeqPool.slice(0, 5);
    const oeqMemberIds = [...new Set(oeqGroups.flatMap(g => g.map(q => q.id)))];
    if (oeqMemberIds.length > 0) {
      const memberRows = await prisma.examQuestion.findMany({
        where: { id: { in: oeqMemberIds } },
        select: { id: true, diagramImageData: true, transcribedSubparts: true },
      });
      const byId = new Map(memberRows.map(r => [r.id, r]));
      for (const group of oeqGroups) {
        for (const q of group) {
          const row = byId.get(q.id);
          if (!row) continue;
          const qx = q as unknown as { diagramImageData?: string | null; transcribedSubparts?: unknown };
          if (!qx.diagramImageData) qx.diagramImageData = row.diagramImageData;
          if (!qx.transcribedSubparts) qx.transcribedSubparts = row.transcribedSubparts;
        }
      }
      T.mark(`oeq-member-hydrate (members=${oeqMemberIds.length})`);
    }
    selectedOeq = oeqGroups.map(mergeOeqGroup);
  }

  const allSelected = [...selectedMcq, ...selectedOeq];

  // Hydrate selected questions with blob data.
  T.mark(`pre-hydrate (mcq=${selectedMcq.length} oeq=${selectedOeq.length})`);
  const blobMap2 = await hydrateBlobs(allSelected.map(q => q.id));
  T.mark(`hydrateBlobs (ids=${allSelected.length})`);
  // Merge invariant ("parts always go together"): mergeOeqGroup OWNS
  // `transcribedSubparts` (the union of every group member's parts) and
  // `diagramImageData` (a fallback chain across members). hydrateBlobs
  // refetches by q.id which == first.id for a merged group, so the
  // refetch returns only the first member's narrower values. If we let
  // them spread on top, the merge gets silently undone — the clone ends
  // up with sub-part (a) only while marksAvailable still reflects the
  // full sum (the Q11 bug from 2026-06-23). Two guard lines below pin
  // q's merged values so no downstream blob fetch can clobber them.
  const allSelectedFull2 = allSelected.map(q => {
    const hydrated = blobMap2.get(q.id);
    const merged = { ...q, ...hydrated } as FullQ;
    if (q.transcribedSubparts) merged.transcribedSubparts = q.transcribedSubparts;
    if (q.diagramImageData) merged.diagramImageData = q.diagramImageData;
    return merged;
  }) as FullQ[];

  const totalMarks = allSelectedFull2.reduce((sum, q) => sum + (isMcq(q.answer) ? 2 : (q.marksAvailable ?? 1)), 0);
  // Title-level labelling — mirrors the English-quiz block above. Use
  // the effective (revision) level so "P5 Revision Quiz – Math" shows
  // up correctly on a P6 student's dashboard.
  const titleLevel = effectiveLevel ?? student?.level ?? null;
  const levelLabel = titleLevel ? `P${titleLevel} ` : "";
  const quizKindLabel = isRevision ? "Revision Quiz" : "Daily Quiz";

  const paper = await prisma.examPaper.create({
    data: {
      title: `${levelLabel}${quizKindLabel} – ${subject === "science" ? "Science" : "Math"} (${quizType === "mcq" ? "MCQ" : "MCQ + OEQ"})`,
      subject: subject === "science" ? "Science" : "Mathematics",
      level: levelFilter || null,
      userId,
      assignedToId: targetStudentId,
      // See English-create note — visible defaults false in the
      // schema, must be true here so the kid can open the quiz.
      visible: true,
      ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        quizType,
        sourceLabels: Object.fromEntries(
          allSelectedFull2.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          })
        ),
      },
      questions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: allSelectedFull2.map((q, i) => ({
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
          transcribedOptionTable: q.transcribedOptionTable ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData,
          diagramBounds: q.diagramBounds ?? undefined,
          sourceQuestionId: q.id,
        })) as any,
      },
    },
  });

  T.mark(`paper.create math/science (qs=${allSelected.length})`);
  return NextResponse.json({ id: paper.id, questionCount: allSelected.length });
}
