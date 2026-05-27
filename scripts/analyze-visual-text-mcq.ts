// Pull Visual Text Comprehension MCQ questions + recent mistakes
// to inform a new master class. Visual Text in PSLE English Booklet A
// is typically Q21-28 (8 questions, 1 mark each).
import { prisma } from "../src/lib/db";

async function main() {
  // 1. Get sample questions to see what's being asked.
  const masterQs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "english", mode: "insensitive" },
        title: { contains: "PSLE", mode: "insensitive" },
      },
      syllabusTopic: "Visual Text Comprehension MCQ",
    },
    select: {
      questionNum: true, answer: true, transcribedStem: true, transcribedOptions: true,
      examPaper: { select: { year: true, title: true } },
    },
    orderBy: [{ examPaper: { year: "desc" } }, { orderIndex: "asc" }],
    take: 60,
  });
  console.log(`=== ${masterQs.length} master Visual Text MCQs ===\n`);
  for (const q of masterQs) {
    const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]) : [];
    console.log(`[${q.examPaper.year}] Q${q.questionNum}  ans=${q.answer}`);
    console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 220).replace(/\n/g, " ")}`);
    opts.forEach((o, i) => console.log(`    (${i + 1}) ${o.slice(0, 120)}`));
    console.log();
  }

  // 2. Now student mistakes on Visual Text MCQ to surface common-error patterns.
  const studentIds = ["cmmbbyvs30004qa9yinn3drl6", "cmm5wf91d000ryrxwaddlo6xh", "cmpnkrb4c001hn6wks6oisdiu"];
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const mistakes = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: { in: studentIds },
        completedAt: { gt: since, not: null },
      },
      syllabusTopic: "Visual Text Comprehension MCQ",
      marksAwarded: { lt: 1 },
      studentAnswer: { not: null },
    },
    select: {
      questionNum: true, answer: true, studentAnswer: true,
      transcribedStem: true, transcribedOptions: true,
      examPaper: { select: { title: true, assignedToId: true, completedAt: true } },
    },
    orderBy: { examPaper: { completedAt: "desc" } },
    take: 40,
  });
  console.log(`\n=== ${mistakes.length} student MISTAKES on Visual Text MCQ (last 90 days) ===\n`);
  for (const q of mistakes) {
    const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]) : [];
    console.log(`--- ${q.examPaper.title.slice(0, 35)}  Q${q.questionNum}`);
    console.log(`  ans: ${q.answer}    student: ${q.studentAnswer}`);
    console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 180).replace(/\n/g, " ")}`);
    opts.slice(0, 4).forEach((o, i) => {
      const isCorrect = String(i + 1) === String(q.answer).replace(/[()]/g, "").trim();
      const isStudent = String(i + 1) === String(q.studentAnswer).replace(/[()]/g, "").trim();
      console.log(`    ${isCorrect ? "✓" : isStudent ? "✗" : " "} (${i + 1}) ${o.slice(0, 120)}`);
    });
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
