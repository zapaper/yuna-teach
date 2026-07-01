// Delete the previous 14-Grammar-MCQ English diagnostic for student67
// and create a new one following the P5/P6 spec:
//   - 7 Grammar MCQ (1 per rule × 7 PSLE grammar rules)
//   - 6 Synthesis OEQ (2 per trick × 3 top tricks)
//
// The Synthesis tricks are the three with the highest PSLE weightage
// AND best supply in our bank: reported-speech, correlative-preference,
// noun-phrase.

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";

const STUDENT_ID = "cmqg8upha0000l3ijfr3co6t8";
const PARENT_ID  = "cmm4tl0f300001ixb254szmg4";
const OLD_ENGLISH_QUIZ_ID = "cmr1lvaf20001zp2n955nypez";
const BASE_URL   = "https://www.markforyou.com";

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
  transcribedStem: string | null;
  transcribedOptions: unknown; transcribedOptionImages: unknown;
  transcribedOptionTable: unknown; transcribedSubparts: unknown;
  diagramImageData: string | null; diagramBounds: unknown;
  marksAvailable: number | null;
  examPaper: { year: string | null; examType: string | null; school: string | null; title: string };
};

(async () => {
  // 1. Delete the old quiz. Cascade removes its questions.
  const old = await prisma.examPaper.findUnique({ where: { id: OLD_ENGLISH_QUIZ_ID }, select: { id: true, title: true } });
  if (old) {
    await prisma.examQuestion.deleteMany({ where: { examPaperId: OLD_ENGLISH_QUIZ_ID } });
    await prisma.examPaper.delete({ where: { id: OLD_ENGLISH_QUIZ_ID } });
    console.log(`Deleted old English quiz: ${old.title} (${OLD_ENGLISH_QUIZ_ID})`);
  }

  // 2. Grammar picks — 1 per rule × 7 rules
  const grammarPool = await prisma.examQuestion.findMany({
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
  const grammarMcq = grammarPool.filter(r => Array.isArray(r.transcribedOptions) && (r.transcribedOptions as unknown[]).length >= 2);
  const grammarPicks: MasterRow[] = [];
  for (const rule of GRAMMAR_RULES) {
    const bucket = grammarMcq.filter(r => r.subTopic === rule);
    const chosen = shuffle(bucket, 0.7 + rule.length).slice(0, 1);
    console.log(`  Grammar · ${rule.padEnd(30)}  pool=${bucket.length}  → ${chosen.length} pick`);
    grammarPicks.push(...chosen);
  }

  // 3. Synthesis picks — 2 per trick × 3 top tricks. Synthesis is OEQ
  // (no options), so we filter to rows with empty transcribedOptions
  // (typed answers).
  const synthPool = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      subTopic: { in: SYNTHESIS_TRICKS },
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
  const synthOeq = synthPool.filter(r => !Array.isArray(r.transcribedOptions) || (r.transcribedOptions as unknown[]).length === 0);
  const synthPicks: MasterRow[] = [];
  for (const trick of SYNTHESIS_TRICKS) {
    const bucket = synthOeq.filter(r => r.subTopic === trick);
    const chosen = shuffle(bucket, 0.7 + trick.length).slice(0, 2);
    console.log(`  Synthesis · ${trick.padEnd(30)}  pool=${bucket.length}  → ${chosen.length} picks`);
    synthPicks.push(...chosen);
  }

  const allPicks = [...grammarPicks, ...synthPicks];
  console.log(`\n  Total: ${grammarPicks.length} grammar + ${synthPicks.length} synthesis = ${allPicks.length}`);

  // 4. Create the paper. Grammar questions are MCQ (worth 2), synthesis
  // are OEQ (worth 2 by PSLE convention).
  const paper = await prisma.examPaper.create({
    data: {
      title: "Onboarding Diagnostic — English (Grammar + Synthesis)",
      subject: "English",
      level: "Primary 6",
      userId: PARENT_ID,
      assignedToId: STUDENT_ID,
      visible: true,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(allPicks.length * 2),
      metadata: {
        quizType: "mcq-oeq",
        onboardingDiagnostic: true,
        englishSections: ["grammar-mcq", "synthesis"],
        sourceLabels: Object.fromEntries(
          allPicks.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          }),
        ),
      },
      questions: {
        create: allPicks.map((q, i) => ({
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

  console.log(`\n══════ New English diagnostic ══════`);
  console.log(`  Quiz URL:   ${BASE_URL}/quiz/${paper.id}?userId=${STUDENT_ID}`);
  console.log(`  Review URL: ${BASE_URL}/exam/${paper.id}/review?userId=${STUDENT_ID}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
