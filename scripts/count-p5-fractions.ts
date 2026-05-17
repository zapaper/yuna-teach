import { prisma } from "../src/lib/db";

(async () => {
  const wherePool = (examTypes: string[] | null) => ({
    syllabusTopic: "Fractions",
    answer: { not: null } as { not: null },
    ...(examTypes ? {
      OR: [
        { examPaper: { examType: { in: examTypes } } },
        { syntheticSourceExamType: { in: examTypes } },
      ],
    } : {}),
    examPaper: {
      sourceExamId: null,
      paperType: null,
      visible: true,
      subject: { contains: "math", mode: "insensitive" as const },
      level: { in: ["P5", "Primary 5", "5"] },
    },
  });

  const all = await prisma.examQuestion.count({ where: wherePool(null) });
  console.log(`P5 Fractions total (all examTypes):  ${all}`);

  const yearEnd = ["EOY", "End of Year", "Prelim", "Preliminary", "SA2"];
  const yearEndCount = await prisma.examQuestion.count({ where: wherePool(yearEnd) });
  console.log(`P5 Fractions from ${yearEnd.join("/")}:  ${yearEndCount}`);

  // Distribution by examType
  const breakdown = await prisma.examQuestion.groupBy({
    by: ["syntheticSourceExamType"],
    where: {
      syllabusTopic: "Fractions",
      answer: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: "math", mode: "insensitive" as const },
        level: { in: ["P5", "Primary 5", "5"] },
      },
    },
    _count: { _all: true },
  });
  console.log("\nBy syntheticSourceExamType:");
  for (const r of breakdown) console.log(`  ${r.syntheticSourceExamType ?? "(none)"} → ${r._count._all}`);

  // Distinct paper-level examType for non-synthetic rows
  const papers = await prisma.examPaper.groupBy({
    by: ["examType"],
    where: {
      sourceExamId: null,
      paperType: null,
      visible: true,
      subject: { contains: "math", mode: "insensitive" as const },
      level: { in: ["P5", "Primary 5", "5"] },
    },
    _count: { _all: true },
  });
  console.log("\nP5 master papers by examType:");
  for (const p of papers) console.log(`  ${p.examType ?? "(none)"} → ${p._count._all}`);

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
