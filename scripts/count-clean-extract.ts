import { prisma } from "../src/lib/db";

(async () => {
  // Master papers only (no clones, no quizzes, no focused tests).
  // Clean-extracted questions have transcribedStem populated.
  const total = await prisma.examQuestion.count({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
      },
    },
  });
  console.log(`Clean-extracted master questions:  ${total}`);

  // Breakdown by subject + level
  const breakdown = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
      },
    },
    select: {
      examPaper: { select: { subject: true, level: true } },
    },
  });
  const counts = new Map<string, number>();
  for (const q of breakdown) {
    const subj = (q.examPaper.subject ?? "?").trim();
    const lvl = q.examPaper.level ?? "?";
    const key = `${subj}  P${lvl}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log("\nBy subject × level:");
  for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(20)} ${n}`);
  }

  // MCQ vs OEQ split
  const all = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: { sourceExamId: null, paperType: null },
    },
    select: { transcribedOptions: true, transcribedOptionImages: true },
  });
  let mcq = 0;
  let oeq = 0;
  for (const q of all) {
    const opts = q.transcribedOptions as unknown[] | null;
    const optImgs = q.transcribedOptionImages as unknown[] | null;
    const isMcq = (Array.isArray(opts) && opts.length === 4) ||
      (Array.isArray(optImgs) && optImgs.some(o => !!o));
    if (isMcq) mcq++;
    else oeq++;
  }
  console.log(`\nMCQ vs OEQ:  ${mcq} MCQ  ·  ${oeq} OEQ`);

  await prisma.$disconnect();
})();
