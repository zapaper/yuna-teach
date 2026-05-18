import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { getMasterClass } from "@/data/master-class";

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
  const content = getMasterClass(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });
  const subTopics = content.subTopics ?? [];
  if (subTopics.length === 0) {
    return NextResponse.json({ error: "Master Class has no sub-topics defined" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as {
    studentId?: string;
    parentMasteryId?: string;
  };
  const studentId = body.studentId;
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });

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
  // Same shape as the focused-test SELECT so cloned mastery questions
  // carry every renderable field — most importantly diagramImageData,
  // which was missing in the first cut and made diagrams disappear.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { equals: content.topicLabel, mode: "insensitive" },
      transcribedStem: { not: null },
      subTopic: { not: null },
      examPaper: { sourceExamId: null, paperType: null },
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
  });

  // ─── Group by subTopic + mcq/oeq ───────────────────────────────────
  const groups = new Map<string, { mcq: typeof candidates; oeq: typeof candidates }>();
  for (const st of subTopics) groups.set(st.id, { mcq: [], oeq: [] });
  for (const q of candidates) {
    if (!q.subTopic || !groups.has(q.subTopic)) continue;
    const g = groups.get(q.subTopic)!;
    if (hasOptions(q)) g.mcq.push(q);
    else g.oeq.push(q);
  }

  // Shuffle within each group.
  for (const [, g] of groups) {
    g.mcq = shuffle(g.mcq);
    g.oeq = shuffle(g.oeq);
  }

  // ─── Selection ─────────────────────────────────────────────────────
  // Pick 1 OEQ per sub-topic first (the firm constraint).
  type Picked = typeof candidates[number];
  const picked: Picked[] = [];
  const oeqPicked = new Set<string>();
  const warnings: string[] = [];
  for (const st of subTopics) {
    const g = groups.get(st.id)!;
    if (g.oeq.length === 0) {
      warnings.push(`No OEQ available for sub-topic "${st.label}".`);
      continue;
    }
    const q = g.oeq.shift()!;
    picked.push(q);
    oeqPicked.add(q.id);
  }

  // Top up to QUIZ_OEQ_COUNT total if any sub-topic was missing.
  while (picked.filter(p => !hasOptions(p)).length < QUIZ_OEQ_COUNT) {
    // Pick the sub-topic with the most remaining OEQ.
    const fallback = [...groups.entries()].sort((a, b) => b[1].oeq.length - a[1].oeq.length)[0];
    if (!fallback || fallback[1].oeq.length === 0) break;
    picked.push(fallback[1].oeq.shift()!);
  }

  // Pick MCQ round-robin from sub-topics until we hit QUIZ_MCQ_COUNT.
  let mcqPickedCount = 0;
  let rounds = 0;
  while (mcqPickedCount < QUIZ_MCQ_COUNT && rounds < 50) {
    rounds++;
    let progressed = false;
    for (const st of subTopics) {
      if (mcqPickedCount >= QUIZ_MCQ_COUNT) break;
      const g = groups.get(st.id)!;
      if (g.mcq.length === 0) continue;
      picked.push(g.mcq.shift()!);
      mcqPickedCount++;
      progressed = true;
    }
    if (!progressed) break;
  }
  if (mcqPickedCount < QUIZ_MCQ_COUNT) {
    warnings.push(`Only ${mcqPickedCount} MCQ available across sub-topics (wanted ${QUIZ_MCQ_COUNT}).`);
  }

  if (picked.length === 0) {
    return NextResponse.json({ error: "No questions available to build a quiz." }, { status: 400 });
  }

  // Shuffle final order so MCQ/OEQ are interleaved, not grouped.
  const finalPicked = shuffle(picked);

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

  const paper = await prisma.examPaper.create({
    data: {
      title: `Mastery: ${content.title} Quiz ${quizNumber}`,
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
          subTopic: q.subTopic,
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

  return NextResponse.json({ paperId: paper.id, warnings, quizNumber });
}
