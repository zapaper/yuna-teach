import { prisma } from "../src/lib/db";

// One-off: create a Math MCQ quiz paper containing 10 questions whose
// transcribedStem contains a `$` (i.e. already converted to LaTeX
// via the admin Convert-to-LaTeX-fraction tool). Useful for sanity-
// checking the on-screen rendering end-to-end.
//
// Usage: npx tsx scripts/create-latex-quiz.ts "Mark Lim"
//   or   npx tsx scripts/create-latex-quiz.ts <studentId>

const STUDENT_QUERY = process.argv[2];
if (!STUDENT_QUERY) {
  console.error("Usage: tsx scripts/create-latex-quiz.ts <studentName|studentId>");
  process.exit(1);
}

async function main() {
  // Resolve student
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

  // Find a parent for this student (any linked parent — paper.userId
  // needs to be set; if none, fall back to admin).
  const link = await prisma.parentStudent.findFirst({
    where: { studentId: student.id },
    select: { parentId: true },
  });
  let parentId = link?.parentId;
  if (!parentId) {
    const admin = await prisma.user.findFirst({
      where: { name: { equals: "admin", mode: "insensitive" } },
      select: { id: true },
    });
    if (!admin) {
      console.error("No linked parent and no admin user found.");
      process.exit(1);
    }
    parentId = admin.id;
    console.log(`No linked parent — owning paper as admin ${admin.id}`);
  }

  // Find candidate Math MCQ questions: transcribedStem contains '$'
  // (LaTeX-converted), MCQ shape (4 transcribedOptions), on a
  // visible master paper. Match the daily-quiz filter so this paper
  // looks like a real quiz.
  // Filter on `\frac{` rather than bare `$` so currency stems
  // like "Aaron had $55..." don't get pulled into the LaTeX test
  // quiz. Real LaTeX-converted Math MCQ always carries at least one
  // \frac (mixed numbers, fractions).
  const candidates = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: "\\frac" },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: "math", mode: "insensitive" },
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

  // Filter: must be a 4-option MCQ.
  const mcqCandidates = candidates.filter(q => {
    const opts = q.transcribedOptions as unknown;
    return Array.isArray(opts) && opts.filter(o => typeof o === "string").length === 4;
  });

  console.log(`Found ${mcqCandidates.length} LaTeX MCQ candidates.`);
  if (mcqCandidates.length === 0) {
    console.error("No LaTeX-converted MCQ questions found. Run the admin Convert-to-LaTeX-fraction tool first.");
    process.exit(1);
  }

  // Take up to 10.
  const selected = mcqCandidates.slice(0, 10);
  console.log(`Selecting ${selected.length} questions:`);
  for (const q of selected) {
    console.log(`  Q${q.questionNum} from "${q.examPaper.title}"`);
  }

  const totalMarks = selected.reduce((s, q) => s + 2, 0); // MCQ in quiz mode = 2 marks each (matches daily-quiz)

  const paper = await prisma.examPaper.create({
    data: {
      title: `LaTeX Test Quiz – Math MCQ (${selected.length} questions)`,
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
        quizType: "mcq",
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
          marksAvailable: 2,
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
