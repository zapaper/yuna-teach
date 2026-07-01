// Two-step for student666 (cmnsa6bww006bgmuwflevt143, P6, linked
// to Papa + admin@yunateach.com):
//   1. Wipe every paper assigned to student666.
//   2. Create the 3 onboarding diagnostic quizzes fresh (English
//      14+6, Math 15 MCQ, Science 15 MCQ), assigned to student666.
//
// Dry-run by default; --apply writes.

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";

const STUDENT_ID = "cmnsa6bww006bgmuwflevt143";  // Student666
const PARENT_ID  = "cmm4tl0f300001ixb254szmg4";  // Papa
const BASE_URL   = "https://www.markforyou.com";
const APPLY = process.argv.includes("--apply");

const P6_LEVELS = ["Primary 6", "P6", "PSLE"];
const GRAMMAR_RULES = [
  "connectors-tenses", "verb-forms", "idiomatic-prepositions",
  "tag-questions", "countable/uncountable", "subject-verb-agreement", "pronouns",
];
const SYNTHESIS_TRICKS = ["reported-speech", "correlative-preference", "noun-phrase"];

function shuffle<T>(a: T[], seed = 0.7): T[] {
  const copy = [...a];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(((Math.sin(seed + i) + 1) / 2) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

type MasterRow = {
  id: string; questionNum: string; syllabusTopic: string | null; subTopic: string | null;
  imageData: string; answer: string | null; answerImageData: string | null;
  elaboration: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown; transcribedOptionImages: unknown;
  transcribedOptionTable: unknown; transcribedSubparts: unknown;
  diagramImageData: string | null; diagramBounds: unknown;
  marksAvailable: number | null;
  examPaper: { year: string | null; examType: string | null; school: string | null; title: string };
};

const SELECT_MASTER = {
  id: true, questionNum: true, syllabusTopic: true, subTopic: true,
  imageData: true, answer: true, answerImageData: true,
  elaboration: true,
  transcribedStem: true,
  transcribedOptions: true, transcribedOptionImages: true,
  transcribedOptionTable: true, transcribedSubparts: true,
  diagramImageData: true, diagramBounds: true, marksAvailable: true,
  examPaper: { select: { year: true, examType: true, school: true, title: true } },
};

function effectiveTopic(syllabus: string | null, sub: string | null): string {
  if (syllabus !== "Basic math operations" && syllabus !== "Basic Math Operations") return syllabus ?? "?";
  return sub ?? syllabus;
}

async function pickMath(): Promise<MasterRow[]> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { not: null },
      examPaper: { sourceExamId: null, paperType: null, extractionStatus: "ready", subject: { contains: "math", mode: "insensitive" }, level: { in: P6_LEVELS } },
    },
    select: SELECT_MASTER,
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const buckets = new Map<string, MasterRow[]>();
  for (const r of mcq) {
    const t = effectiveTopic(r.syllabusTopic, r.subTopic);
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(r);
  }
  const ranked = [...buckets.entries()].filter(([, arr]) => arr.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const picks: MasterRow[] = [];
  for (const [topic, arr] of ranked) {
    const chosen = shuffle(arr, 0.9 + topic.length).slice(0, 3);
    console.log(`  Math · ${topic.padEnd(30)}  pool=${arr.length}  → 3 picks`);
    picks.push(...chosen);
  }
  return picks;
}

async function pickScience(): Promise<MasterRow[]> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { not: null },
      examPaper: { sourceExamId: null, paperType: null, extractionStatus: "ready", subject: { contains: "science", mode: "insensitive" }, level: { in: P6_LEVELS } },
    },
    select: SELECT_MASTER,
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const buckets = new Map<string, MasterRow[]>();
  for (const r of mcq) {
    const t = r.syllabusTopic ?? "?";
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(r);
  }
  const ranked = [...buckets.entries()].filter(([, arr]) => arr.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const picks: MasterRow[] = [];
  for (const [topic, arr] of ranked) {
    const chosen = shuffle(arr, 0.9 + topic.length).slice(0, 3);
    console.log(`  Science · ${topic.padEnd(50)}  pool=${arr.length}  → 3 picks`);
    picks.push(...chosen);
  }
  return picks;
}

async function pickEnglish(): Promise<MasterRow[]> {
  // Grammar: 2 per rule × 7 rules = 14
  const grammarRows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null, syllabusTopic: "Grammar MCQ",
      examPaper: { sourceExamId: null, paperType: null, extractionStatus: "ready", subject: { contains: "english", mode: "insensitive" }, level: { in: P6_LEVELS } },
    },
    select: SELECT_MASTER,
  });
  const grammarMcq = grammarRows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const grammarPicks: MasterRow[] = [];
  for (const rule of GRAMMAR_RULES) {
    const bucket = grammarMcq.filter(r => r.subTopic === rule);
    const chosen = shuffle(bucket, 0.9 + rule.length).slice(0, 2);
    console.log(`  English · ${rule.padEnd(30)}  pool=${bucket.length}  → ${chosen.length} picks`);
    grammarPicks.push(...chosen);
  }
  // Synthesis: 2 per trick × 3 tricks = 6
  const synthRows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      subTopic: { in: SYNTHESIS_TRICKS },
      examPaper: { sourceExamId: null, paperType: null, extractionStatus: "ready", subject: { contains: "english", mode: "insensitive" }, level: { in: P6_LEVELS } },
    },
    select: SELECT_MASTER,
  });
  const synthOeq = synthRows.filter(r => !Array.isArray(r.transcribedOptions) || (r.transcribedOptions as unknown[]).length === 0);
  const synthPicks: MasterRow[] = [];
  for (const trick of SYNTHESIS_TRICKS) {
    const bucket = synthOeq.filter(r => r.subTopic === trick);
    const chosen = shuffle(bucket, 0.9 + trick.length).slice(0, 2);
    console.log(`  Synthesis · ${trick.padEnd(30)}  pool=${bucket.length}  → ${chosen.length} picks`);
    synthPicks.push(...chosen);
  }
  return [...grammarPicks, ...synthPicks];
}

async function createQuizPaper(subject: string, subjectCol: string, picks: MasterRow[], englishSections?: Array<{ label: string; startIndex: number; endIndex: number }>): Promise<string> {
  const paper = await prisma.examPaper.create({
    data: {
      title: `Onboarding Diagnostic — ${subject}${englishSections ? " (Grammar + Synthesis)" : " (MCQ)"}`,
      subject: subjectCol,
      level: "Primary 6",
      userId: PARENT_ID,
      assignedToId: STUDENT_ID,
      visible: true,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(picks.length * 2),
      metadata: {
        quizType: englishSections ? "mcq-oeq" : "mcq",
        onboardingDiagnostic: true,
        ...(englishSections ? { englishSections } : {}),
        sourceLabels: Object.fromEntries(picks.map((q, i) => {
          const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
          return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
        })),
      },
      questions: {
        create: picks.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          // Copy the master elaboration into the clone so the review
          // page's auto-expand for wrong MCQs picks it up without a
          // fetch. The mark route also falls back to master.elab now,
          // but making the clone self-sufficient is cheaper at request
          // time.
          elaboration: q.elaboration,
          marksAvailable: 2,
          syllabusTopic: q.syllabusTopic,
          subTopic: q.subTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: (q.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedOptionImages: (q.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedOptionTable: (q.transcribedOptionTable ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedSubparts: (q.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          diagramImageData: q.diagramImageData,
          diagramBounds: (q.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true },
  });
  return paper.id;
}

(async () => {
  // 1) Wipe existing papers
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: STUDENT_ID },
    select: { id: true, title: true, paperType: true, _count: { select: { questions: true } } },
  });
  console.log(`Student666 currently has ${papers.length} papers`);
  for (const p of papers) console.log(`  ${(p.paperType ?? "master").padEnd(8)}  qs=${p._count.questions.toString().padStart(3)}  → ${p.title}`);

  if (!APPLY) {
    console.log(`\n[DRY RUN] would delete ${papers.length} papers, then create 3 onboarding diagnostics.`);
    await prisma.$disconnect();
    return;
  }

  const dropIds = papers.map(p => p.id);
  if (dropIds.length > 0) {
    const qDel = await prisma.examQuestion.deleteMany({ where: { examPaperId: { in: dropIds } } });
    const pDel = await prisma.examPaper.deleteMany({ where: { id: { in: dropIds } } });
    console.log(`\nDeleted ${pDel.count} papers · ${qDel.count} questions`);
  }
  // Also clear tutorCache
  const u = await prisma.user.findUnique({ where: { id: STUDENT_ID }, select: { settings: true } });
  if (u?.settings) {
    const s = { ...(u.settings as Record<string, unknown>) };
    let dropped = 0;
    for (const k of ["tutorCache", "lumiLastWeek", "activationNudgeSent", "activationFollowupSent", "lumiIntroSent"]) {
      if (k in s) { delete s[k]; dropped++; }
    }
    if (dropped > 0) {
      await prisma.user.update({ where: { id: STUDENT_ID }, data: { settings: s } });
      console.log(`Cleared ${dropped} tutorCache keys.`);
    }
  }

  // 2) Fresh picks + create
  console.log(`\n── Picking English ──`);
  const eng = await pickEnglish();
  console.log(`── Picking Math ──`);
  const math = await pickMath();
  console.log(`── Picking Science ──`);
  const sci = await pickScience();

  // English: first 14 = Grammar MCQ, next 6 = Synthesis (typed OEQ).
  // The quiz page reads englishSections[].label to detect typed
  // sections — must be OBJECTS with { label, startIndex, endIndex },
  // not string tags. Grammar label "Grammar MCQ", Synthesis label
  // "Synthesis & Transformation" so `.toLowerCase().includes("synthesis")`
  // matches (see src/app/quiz/[id]/page.tsx around line 935).
  const engSections = [
    { label: "Grammar MCQ", startIndex: 0, endIndex: 13 },
    { label: "Synthesis & Transformation", startIndex: 14, endIndex: 19 },
  ];
  const engId = await createQuizPaper("English", "English", eng, engSections);
  const mathId = await createQuizPaper("Math", "Mathematics", math);
  const sciId = await createQuizPaper("Science", "Science", sci);

  console.log(`\n══════ Onboarding diagnostic URLs (Student666) ══════`);
  console.log(`  English (${eng.length}q):  ${BASE_URL}/quiz/${engId}?userId=${STUDENT_ID}`);
  console.log(`  Math    (${math.length}q): ${BASE_URL}/quiz/${mathId}?userId=${STUDENT_ID}`);
  console.log(`  Science (${sci.length}q):  ${BASE_URL}/quiz/${sciId}?userId=${STUDENT_ID}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
