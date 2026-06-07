// Generate a Science table-MCQ quiz for student666. Pulls every PSLE
// Science MCQ whose options are stored as transcribedOptionTable
// (table-format MCQ — each row is one option). Creates a new ExamPaper
// row, paperType="quiz", assigned to student666, with the questions
// cloned (sourceQuestionId pointing back to the master).

import { prisma } from "../src/lib/db";

const STUDENT_ID = "cmnsa6bww006bgmuwflevt143"; // Student666 P6

async function main() {
  const student = await prisma.user.findUnique({
    where: { id: STUDENT_ID },
    select: { id: true, name: true, level: true, role: true },
  });
  if (!student) {
    console.error(`Student ${STUDENT_ID} not found`); process.exit(1);
  }
  console.log(`Target: ${student.name} (P${student.level})`);

  // All PSLE Science master papers
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "science", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: { id: true, year: true, title: true },
    orderBy: { year: "asc" },
  });

  // Pull every question with a non-null transcribedOptionTable.
  type SourceQ = {
    id: string; questionNum: string; imageData: string; answer: string;
    answerImageData: string | null; marksAvailable: number | null;
    syllabusTopic: string | null;
    transcribedStem: string | null;
    transcribedOptionTable: unknown;
    transcribedOptions: unknown;
    transcribedOptionImages: unknown;
    diagramImageData: string | null; diagramBounds: unknown;
    year: string | null; paperTitle: string;
    cols: number;
  };
  const pool: SourceQ[] = [];
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, transcribedOptionTable: { not: undefined } },
      select: {
        id: true, questionNum: true, imageData: true, answer: true,
        answerImageData: true, marksAvailable: true, syllabusTopic: true,
        transcribedStem: true,
        transcribedOptionTable: true,
        transcribedOptions: true,
        transcribedOptionImages: true,
        diagramImageData: true, diagramBounds: true,
        orderIndex: true,
      },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      const t = q.transcribedOptionTable as { columns?: string[]; rows?: string[][] } | null;
      if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows) || t.rows.length !== 4) continue;
      pool.push({
        id: q.id, questionNum: q.questionNum,
        imageData: q.imageData ?? "", answer: q.answer ?? "",
        answerImageData: q.answerImageData, marksAvailable: q.marksAvailable,
        syllabusTopic: q.syllabusTopic,
        transcribedStem: q.transcribedStem,
        transcribedOptionTable: q.transcribedOptionTable,
        transcribedOptions: q.transcribedOptions,
        transcribedOptionImages: q.transcribedOptionImages,
        diagramImageData: q.diagramImageData, diagramBounds: q.diagramBounds,
        year: p.year, paperTitle: p.title,
        cols: t.columns.length,
      });
    }
  }

  // Sort heaviest-first (more cols = harder mobile read). Keeps the
  // student facing the tight ones first while they're still fresh.
  pool.sort((a, b) => b.cols - a.cols);
  console.log(`Picked ${pool.length} table-MCQ questions (cols: ${pool.map(p => p.cols).join(", ")})`);

  const totalMarks = pool.reduce((s, q) => s + (q.marksAvailable ?? 2), 0);

  const paper = await prisma.examPaper.create({
    data: {
      title: `Science Table-MCQ Practice (${pool.length} Qs)`,
      subject: "Science",
      level: student.level ? `P${student.level}` : null,
      userId: student.id,           // student owns it (no parent linked)
      assignedToId: student.id,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      questions: {
        create: pool.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData ?? "",
          marksAvailable: q.marksAvailable ?? 2,
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transcribedOptions: (q.transcribedOptions as any) ?? undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transcribedOptionImages: (q.transcribedOptionImages as any) ?? undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transcribedOptionTable: (q.transcribedOptionTable as any) ?? undefined,
          diagramImageData: q.diagramImageData,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          diagramBounds: (q.diagramBounds as any) ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true, title: true },
  });

  console.log(`\nCreated quiz: ${paper.id}`);
  console.log(`Title: ${paper.title}`);
  console.log(`URL: https://www.markforyou.com/quiz/${paper.id}?userId=${student.id}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
