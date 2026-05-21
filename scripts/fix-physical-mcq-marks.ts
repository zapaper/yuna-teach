// One-off: PSLE MCQs are 2 marks each, but the Physical Science MCQ
// master paper stores 1 mark per question. Fix that and also look up
// Q14b on the Life OEQ paper (null marks) to flag it for review.
import { prisma } from "../src/lib/db";

(async () => {
  const physicalMcq = await prisma.examPaper.findFirst({
    where: { sourceExamId: null, title: "PSLE Physical Science MCQ 2022-2024" },
    select: { id: true, title: true },
  });
  if (!physicalMcq) {
    console.error("Physical MCQ master not found"); process.exit(1);
  }
  const before = await prisma.examQuestion.aggregate({
    where: { examPaperId: physicalMcq.id },
    _sum: { marksAvailable: true },
    _count: true,
  });
  console.log(`Before fix: ${before._count} questions, ${before._sum.marksAvailable} total marks`);

  // Only touch questions currently set to 1 mark — leaves anything
  // already scored differently alone.
  const updated = await prisma.examQuestion.updateMany({
    where: { examPaperId: physicalMcq.id, marksAvailable: 1 },
    data: { marksAvailable: 2 },
  });
  console.log(`Updated ${updated.count} questions from 1m to 2m`);

  const after = await prisma.examQuestion.aggregate({
    where: { examPaperId: physicalMcq.id },
    _sum: { marksAvailable: true },
  });
  console.log(`After fix: ${after._sum.marksAvailable} total marks`);

  // Sibling check: Q14b null marks on Life OEQ — peek at Q14a and any
  // other 14-series subparts so the user can decide a value.
  const lifeOeq = await prisma.examPaper.findFirst({
    where: { sourceExamId: null, title: "PSLE Life Science OEQ 2022-2024" },
    select: { id: true },
  });
  if (lifeOeq) {
    const q14s = await prisma.examQuestion.findMany({
      where: { examPaperId: lifeOeq.id, questionNum: { startsWith: "14" } },
      select: { questionNum: true, marksAvailable: true, transcribedStem: true },
      orderBy: { questionNum: "asc" },
    });
    console.log(`\nLife OEQ Q14 family:`);
    for (const q of q14s) {
      console.log(`  Q${q.questionNum}  marks=${q.marksAvailable ?? "NULL"}  stem="${(q.transcribedStem ?? "").slice(0, 80)}…"`);
    }
  }
  await prisma.$disconnect();
})();
