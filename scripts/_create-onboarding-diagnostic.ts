// Create 3 onboarding-diagnostic MCQ quizzes for student67:
//   1. English — 14 Grammar MCQ (2 per PSLE rule × 7 rules)
//   2. Math    — 15 MCQ (3 per top-5 topic from the P6+PSLE pool)
//   3. Science — 15 MCQ (3 per top-5 topic from the P6+PSLE pool)
//
// Each quiz is a paperType='quiz', assignedToId=student67. Print the
// direct kid-facing quiz URLs at the end so we can share them.
//
// Uses the same shape as /api/daily-quiz creates. Idempotent-ish:
// re-run creates a NEW set of quizzes with fresh titles — safe.

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";

const STUDENT_ID = "cmqg8upha0000l3ijfr3co6t8";     // student67
const PARENT_ID  = "cmm4tl0f300001ixb254szmg4";     // Peter (adminish)
const BASE_URL   = "https://www.markforyou.com";

const P6_LEVELS = ["Primary 6", "P6", "PSLE"];
const GRAMMAR_RULES = [
  "connectors-tenses", "verb-forms", "idiomatic-prepositions",
  "tag-questions", "countable/uncountable", "subject-verb-agreement", "pronouns",
];

// Basic-ops sub-topics live on subTopic; for the top-5 pick we treat
// each Basic-ops sub-topic as its own "topic".
function effectiveTopic(syllabus: string | null, sub: string | null): string {
  if (syllabus !== "Basic math operations" && syllabus !== "Basic Math Operations") return syllabus ?? "?";
  return sub ?? syllabus;
}

function shuffle<T>(a: T[], seed = 0.7): T[] {
  // Stable-ish shuffle so re-runs produce different orders — good
  // enough for a one-off diagnostic pick.
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
  transcribedStem: string | null;
  transcribedOptions: unknown; transcribedOptionImages: unknown;
  transcribedOptionTable: unknown; transcribedSubparts: unknown;
  diagramImageData: string | null; diagramBounds: unknown;
  marksAvailable: number | null;
  examPaper: { year: string | null; examType: string | null; school: string | null; title: string };
};

async function pickMath(): Promise<MasterRow[]> {
  // Pool: level in P6+PSLE, master, MCQ, tagged
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { not: null },
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "math", mode: "insensitive" },
        level: { in: P6_LEVELS },
      },
    },
    select: {
      id: true, questionNum: true, syllabusTopic: true, subTopic: true,
      imageData: true, answer: true, answerImageData: true,
      transcribedStem: true,
      transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      diagramImageData: true, diagramBounds: true, marksAvailable: true,
      examPaper: { select: { year: true, examType: true, school: true, title: true } },
    },
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  // Bucket by effectiveTopic; pick top 5 with ≥3 each
  const buckets = new Map<string, MasterRow[]>();
  for (const r of mcq) {
    const t = effectiveTopic(r.syllabusTopic, r.subTopic);
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(r);
  }
  const ranked = [...buckets.entries()]
    .filter(([, arr]) => arr.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  const picks: MasterRow[] = [];
  for (const [topic, arr] of ranked) {
    const chosen = shuffle(arr, 0.7 + topic.length).slice(0, 3);
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
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
        level: { in: P6_LEVELS },
      },
    },
    select: {
      id: true, questionNum: true, syllabusTopic: true, subTopic: true,
      imageData: true, answer: true, answerImageData: true,
      transcribedStem: true,
      transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      diagramImageData: true, diagramBounds: true, marksAvailable: true,
      examPaper: { select: { year: true, examType: true, school: true, title: true } },
    },
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const buckets = new Map<string, MasterRow[]>();
  for (const r of mcq) {
    const t = r.syllabusTopic ?? "?";
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(r);
  }
  const ranked = [...buckets.entries()]
    .filter(([, arr]) => arr.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  const picks: MasterRow[] = [];
  for (const [topic, arr] of ranked) {
    const chosen = shuffle(arr, 0.7 + topic.length).slice(0, 3);
    console.log(`  Science · ${topic.padEnd(50)}  pool=${arr.length}  → 3 picks`);
    picks.push(...chosen);
  }
  return picks;
}

async function pickEnglish(): Promise<MasterRow[]> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: "Grammar MCQ",
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "english", mode: "insensitive" },
        level: { in: P6_LEVELS },
      },
    },
    select: {
      id: true, questionNum: true, syllabusTopic: true, subTopic: true,
      imageData: true, answer: true, answerImageData: true,
      transcribedStem: true,
      transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      diagramImageData: true, diagramBounds: true, marksAvailable: true,
      examPaper: { select: { year: true, examType: true, school: true, title: true } },
    },
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const picks: MasterRow[] = [];
  for (const rule of GRAMMAR_RULES) {
    const bucket = mcq.filter(r => r.subTopic === rule);
    if (bucket.length < 2) {
      console.log(`  English · ${rule.padEnd(30)}  pool=${bucket.length}  ⚠ short — picking what we have`);
      picks.push(...bucket);
      continue;
    }
    const chosen = shuffle(bucket, 0.7 + rule.length).slice(0, 2);
    console.log(`  English · ${rule.padEnd(30)}  pool=${bucket.length}  → 2 picks`);
    picks.push(...chosen);
  }
  return picks;
}

async function createQuizPaper(subject: "English" | "Math" | "Science", picks: MasterRow[]): Promise<string> {
  const title = `Onboarding Diagnostic — ${subject} (MCQ)`;
  const subjectCol = subject === "Math" ? "Mathematics" : subject;
  const paper = await prisma.examPaper.create({
    data: {
      title,
      subject: subjectCol,
      level: "Primary 6",
      userId: PARENT_ID,
      assignedToId: STUDENT_ID,
      visible: true,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(picks.reduce((s, p) => s + 2, 0)),
      metadata: {
        quizType: "mcq",
        onboardingDiagnostic: true,
        sourceLabels: Object.fromEntries(
          picks.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          }),
        ),
      },
      questions: {
        create: picks.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
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
  console.log(`Building diagnostic quizzes for student67 (${STUDENT_ID})\n`);

  console.log(`── English Grammar MCQ picks ──`);
  const eng = await pickEnglish();
  console.log(`  total picks: ${eng.length}\n`);

  console.log(`── Math MCQ picks ──`);
  const math = await pickMath();
  console.log(`  total picks: ${math.length}\n`);

  console.log(`── Science MCQ picks ──`);
  const sci = await pickScience();
  console.log(`  total picks: ${sci.length}\n`);

  const engId = await createQuizPaper("English", eng);
  const mathId = await createQuizPaper("Math", math);
  const sciId = await createQuizPaper("Science", sci);

  console.log(`\n══════ Quiz URLs (open as student67) ══════`);
  console.log(`  English (${eng.length} MCQ):  ${BASE_URL}/quiz/${engId}?userId=${STUDENT_ID}`);
  console.log(`  Math    (${math.length} MCQ): ${BASE_URL}/quiz/${mathId}?userId=${STUDENT_ID}`);
  console.log(`  Science (${sci.length} MCQ): ${BASE_URL}/quiz/${sciId}?userId=${STUDENT_ID}`);
  console.log(`\nReview URLs (after submission):`);
  console.log(`  English:  ${BASE_URL}/exam/${engId}/review?userId=${STUDENT_ID}`);
  console.log(`  Math:     ${BASE_URL}/exam/${mathId}/review?userId=${STUDENT_ID}`);
  console.log(`  Science:  ${BASE_URL}/exam/${sciId}/review?userId=${STUDENT_ID}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
