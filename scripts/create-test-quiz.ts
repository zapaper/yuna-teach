import { prisma } from "../src/lib/db";

// Long-form test quiz builder. Pulls from master papers and creates
// a paperType:"quiz" assigned to the named student. Mixed mode pulls
// MCQ + OEQ together; mcq mode is MCQ only.
//
// Usage:
//   npx tsx scripts/create-test-quiz.ts "<studentName>" <math|science> <mcq|mcq-oeq> [count]
//
// Examples:
//   npx tsx scripts/create-test-quiz.ts "Mark Lim" math mcq-oeq 30
//   npx tsx scripts/create-test-quiz.ts "Mark Lim" science mcq 20

const STUDENT_QUERY = process.argv[2];
const SUBJECT_ARG = (process.argv[3] ?? "math").toLowerCase();
const TYPE_ARG = (process.argv[4] ?? "mcq-oeq").toLowerCase() as "mcq" | "mcq-oeq";
const COUNT = parseInt(process.argv[5] ?? "30", 10);

if (!STUDENT_QUERY) {
  console.error("Usage: tsx scripts/create-test-quiz.ts \"<studentName|studentId>\" <math|science> <mcq|mcq-oeq> [count]");
  process.exit(1);
}

const SUBJECT_MATCH = SUBJECT_ARG === "science" ? "science" : "math";

async function main() {
  const byId = await prisma.user.findUnique({
    where: { id: STUDENT_QUERY },
    select: { id: true, name: true, displayName: true, role: true, level: true },
  });
  const student = byId ?? await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      OR: [
        { name: { equals: STUDENT_QUERY, mode: "insensitive" } },
        { displayName: { equals: STUDENT_QUERY, mode: "insensitive" } },
        { name: { contains: STUDENT_QUERY, mode: "insensitive" } },
        { displayName: { contains: STUDENT_QUERY, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, role: true, level: true },
  });
  if (!student || student.role !== "STUDENT") {
    console.error(`No student found matching "${STUDENT_QUERY}"`);
    process.exit(1);
  }
  console.log(`Student: ${student.displayName ?? student.name} (${student.id}) P${student.level ?? "?"}`);

  const link = await prisma.parentStudent.findFirst({
    where: { studentId: student.id },
    select: { parentId: true },
  });
  let parentId = link?.parentId;
  if (!parentId) {
    const admin = await prisma.user.findFirst({ where: { name: { equals: "admin", mode: "insensitive" } }, select: { id: true } });
    if (!admin) { console.error("No linked parent and no admin user."); process.exit(1); }
    parentId = admin.id;
    console.log(`No linked parent — owning paper as admin ${admin.id}`);
  }

  const levelVariants = student.level
    ? [`P${student.level}`, `Primary ${student.level}`, String(student.level)]
    : null;

  // MCQ pool: 4 transcribed options, MCQ-shaped answer
  const allQs = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      answer: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: SUBJECT_MATCH, mode: "insensitive" },
        ...(levelVariants ? { level: { in: levelVariants } } : {}),
        NOT: [
          { examType: "Synthetic" },
          { title: { startsWith: "[Synthetic Bank]" } },
        ],
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedSubparts: true,
      diagramBounds: true,
      diagramImageData: true,
      imageData: true,
      answer: true,
      answerImageData: true,
      marksAvailable: true,
      syllabusTopic: true,
      examPaper: { select: { id: true, year: true, examType: true, school: true, title: true } },
    },
    orderBy: { id: "asc" },
  });

  const isMcqQ = (q: typeof allQs[number]) => {
    const opts = q.transcribedOptions as unknown;
    return Array.isArray(opts) && opts.filter(o => typeof o === "string").length === 4;
  };
  const mcqQs = allQs.filter(isMcqQ);
  const oeqQs = allQs.filter(q => !isMcqQ(q));

  console.log(`Pool: ${mcqQs.length} MCQ, ${oeqQs.length} OEQ available for ${SUBJECT_MATCH} P${student.level}`);

  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let selected: typeof allQs;
  if (TYPE_ARG === "mcq") {
    selected = shuffle(mcqQs).slice(0, COUNT);
  } else {
    // 70% MCQ, 30% OEQ-ish split.
    const mcqTake = Math.min(mcqQs.length, Math.ceil(COUNT * 0.7));
    const oeqTake = Math.min(oeqQs.length, COUNT - mcqTake);
    selected = [...shuffle(mcqQs).slice(0, mcqTake), ...shuffle(oeqQs).slice(0, oeqTake)];
  }

  if (selected.length === 0) {
    console.error("No questions selected.");
    process.exit(1);
  }
  console.log(`Selecting ${selected.length} questions:`);
  for (const q of selected) {
    const opts = q.transcribedOptions as unknown;
    const isMcq = Array.isArray(opts) && opts.filter(o => typeof o === "string").length === 4;
    console.log(`  ${isMcq ? "MCQ" : "OEQ"} Q${q.questionNum} from "${q.examPaper.title}"`);
  }

  const totalMarks = selected.reduce((s, q) => {
    const isMcq = isMcqQ(q);
    return s + (isMcq ? 2 : (q.marksAvailable ?? 1));
  }, 0);

  const subjectLabel = SUBJECT_MATCH === "science" ? "Science" : "Mathematics";
  const typeLabel = TYPE_ARG === "mcq" ? "MCQ" : "MCQ + OEQ";
  const paper = await prisma.examPaper.create({
    data: {
      title: `Test Quiz – ${subjectLabel} P${student.level ?? "?"} (${typeLabel}, ${selected.length}q)`,
      subject: subjectLabel,
      level: student.level ? `Primary ${student.level}` : null,
      userId: parentId,
      assignedToId: student.id,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        quizType: TYPE_ARG,
        sourceLabels: Object.fromEntries(
          selected.map((q, i) => {
            const parts = [q.examPaper.year, q.examPaper.examType, q.examPaper.school].filter(Boolean);
            return [String(i + 1), parts.length > 0 ? parts.join(" ") : null];
          })
        ),
      },
      questions: {
        create: selected.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: isMcqQ(q) ? 2 : (q.marksAvailable ?? 1),
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData,
          diagramBounds: q.diagramBounds ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true },
  });

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://www.markforyou.com";
  console.log(`\n✓ Created quiz paper: ${paper.id}`);
  console.log(`  Student URL: ${baseUrl}/quiz/${paper.id}?userId=${student.id}`);
  console.log(`  Parent review (after submission): ${baseUrl}/exam/${paper.id}/review?userId=${parentId}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
