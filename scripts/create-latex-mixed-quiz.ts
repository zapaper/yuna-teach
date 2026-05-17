import { prisma } from "../src/lib/db";

// One-off: quiz with exactly 10 MCQ + 10 OEQ Math questions whose
// transcribedStem (or option / subpart text) contains a LaTeX
// `\frac{}` — i.e. already converted via the admin tool. Helpful for
// end-to-end testing of the LaTeX rendering across both formats.

const STUDENT_QUERY = process.argv[2] ?? "Mark Lim";
const MCQ_COUNT = 10;
const OEQ_COUNT = 10;

async function main() {
  const byId = await prisma.user.findUnique({
    where: { id: STUDENT_QUERY },
    select: { id: true, name: true, displayName: true, role: true, level: true },
  });
  const student = byId ?? await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      OR: [
        { name: { contains: STUDENT_QUERY, mode: "insensitive" } },
        { displayName: { contains: STUDENT_QUERY, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, role: true, level: true },
  });
  if (!student || student.role !== "STUDENT") {
    console.error(`No student matching "${STUDENT_QUERY}"`);
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
  }

  const levelVariants = student.level
    ? [`P${student.level}`, `Primary ${student.level}`, String(student.level)]
    : null;

  // Pull every Math master-paper question whose stem contains \frac.
  // Then partition into MCQ (4 string options) vs OEQ.
  const all = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: "\\frac" },
      answer: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: "math", mode: "insensitive" },
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
  });

  const isMcq = (q: typeof all[number]) => {
    const opts = q.transcribedOptions as unknown;
    return Array.isArray(opts) && opts.filter(o => typeof o === "string").length === 4;
  };
  const mcqs = all.filter(isMcq);
  const oeqs = all.filter(q => !isMcq(q));

  console.log(`Pool: ${mcqs.length} MCQ + ${oeqs.length} OEQ with LaTeX fractions, P${student.level}`);
  if (mcqs.length === 0 && oeqs.length === 0) {
    console.error("No LaTeX-converted Math questions found at this level. Run the admin tool first.");
    process.exit(1);
  }

  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const selectedMcq = shuffle(mcqs).slice(0, MCQ_COUNT);
  const selectedOeq = shuffle(oeqs).slice(0, OEQ_COUNT);
  const selected = [...selectedMcq, ...selectedOeq];

  console.log(`\nSelecting ${selected.length} questions:`);
  for (const q of selected) {
    console.log(`  ${isMcq(q) ? "MCQ" : "OEQ"} Q${q.questionNum} from "${q.examPaper.title}"`);
  }

  const totalMarks = selected.reduce((s, q) => s + (isMcq(q) ? 2 : (q.marksAvailable ?? 1)), 0);

  const paper = await prisma.examPaper.create({
    data: {
      title: `LaTeX Test Quiz – Math P${student.level ?? "?"} (${selectedMcq.length} MCQ + ${selectedOeq.length} OEQ)`,
      subject: "Mathematics",
      level: student.level ? `Primary ${student.level}` : null,
      userId: parentId,
      assignedToId: student.id,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      metadata: {
        quizType: "mcq-oeq",
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
          marksAvailable: isMcq(q) ? 2 : (q.marksAvailable ?? 1),
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
