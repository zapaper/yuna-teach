import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { getMasterClassHydrated } from "@/lib/master-class/hydrate";
import { classifyPatternQuestion } from "@/lib/master-class/classify-pattern";
import { classifyCircuitsQuestion } from "@/lib/master-class/classify-circuits";

// Per-slug stem classifier. When the source question has no
// subTopic tag, we fill it in at clone time so per-sub-topic
// mastery tracking still works.
const STEM_CLASSIFIERS: Record<string, (stem: string | null) => string | null> = {
  "patterns": classifyPatternQuestion,
  "electrical-circuits": classifyCircuitsQuestion,
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

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await context.params;
  const content = await getMasterClassHydrated(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });
  const subTopics = content.subTopics ?? [];
  // Sub-topics only required for non-regex classes (the per-sub-topic
  // round-robin picker uses them). Regex-mode classes do a single-pool
  // pick instead.
  if (!content.practiceStemRegex && subTopics.length === 0) {
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
  const candidatesRaw = await prisma.examQuestion.findMany({
    where: {
      ...(useRegex
        ? { transcribedStem: { not: null } }
        : useClassifier
          ? { syllabusTopic: { equals: content.topicLabel, mode: "insensitive" }, transcribedStem: { not: null } }
          : { syllabusTopic: { equals: content.topicLabel, mode: "insensitive" }, transcribedStem: { not: null }, subTopic: { not: null } }),
      examPaper: {
        sourceExamId: null,
        paperType: null,
        ...(useRegex ? { subject: { contains: content.subject, mode: "insensitive" } } : {}),
      },
    },
    select: {
      id: true,
      questionNum: true,
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
    },
    take: useRegex ? 4000 : undefined,
  });
  const candidates = useRegex
    ? candidatesRaw.filter(q => {
        try { return new RegExp(content.practiceStemRegex!, "i").test(q.transcribedStem ?? ""); }
        catch { return false; }
      })
    : candidatesRaw;

  // ─── Group by subTopic + mcq/oeq ───────────────────────────────────
  // Regex-mode master classes (Patterns) don't have per-question
  // sub-topic tags yet, so we lump everything into a single bucket.
  const groups = new Map<string, { mcq: typeof candidates; oeq: typeof candidates }>();
  if (useRegex) {
    groups.set("_all", { mcq: [], oeq: [] });
    for (const q of candidates) {
      const g = groups.get("_all")!;
      if (hasOptions(q)) g.mcq.push(q); else g.oeq.push(q);
    }
  } else {
    for (const st of subTopics) groups.set(st.id, { mcq: [], oeq: [] });
    // Classifier-based slugs (Circuits) re-tag from the stem; pure
    // tagged slugs (Interactions) use the admin-set subTopic field.
    const classifier = STEM_CLASSIFIERS[slug];
    for (const q of candidates) {
      const subTopicId = classifier ? classifier(q.transcribedStem) : q.subTopic;
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

  // Shuffle within each group, then dedupe by stem.
  for (const [, g] of groups) {
    g.mcq = dedupeByStem(shuffle(g.mcq));
    g.oeq = dedupeByStem(shuffle(g.oeq));
  }

  // ─── Selection ─────────────────────────────────────────────────────
  type Picked = typeof candidates[number];
  const picked: Picked[] = [];
  const warnings: string[] = [];
  // Per-master-class quiz size: YAML can override the defaults via
  // the first slide's cta.quizSpec. (Patterns wants 6 + 4 instead of
  // 10 + 6 because the pool is smaller.)
  const allSlides = [...content.keyConcepts, ...content.commonMistakes];
  const quizSpec = allSlides.map(s => s.cta?.quizSpec).find(Boolean);
  const mcqTarget = quizSpec?.mcq ?? QUIZ_MCQ_COUNT;
  const oeqTarget = quizSpec?.oeq ?? QUIZ_OEQ_COUNT;

  if (useRegex) {
    // Single-bucket pick — just take the first N OEQ then the first
    // N MCQ from the deduped/shuffled pool.
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
    // Pick 1 OEQ per sub-topic first (the firm constraint).
    for (const st of subTopics) {
      const g = groups.get(st.id)!;
      if (g.oeq.length === 0) {
        warnings.push(`No OEQ available for sub-topic "${st.label}".`);
        continue;
      }
      picked.push(g.oeq.shift()!);
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
          // source's subTopic for classes that don't need it.
          subTopic: STEM_CLASSIFIERS[slug]
            ? STEM_CLASSIFIERS[slug](q.transcribedStem)
            : q.subTopic,
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
  const sourceQuestions = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: {
      id: true,
      questionNum: true,
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
    },
  });
  // Preserve the most-recent-wrong-first order from sourceIds.
  const byId = new Map(sourceQuestions.map(q => [q.id, q]));
  const orderedSources = sourceIds.map(id => byId.get(id)).filter((q): q is NonNullable<typeof q> => !!q);

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
