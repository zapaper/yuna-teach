// Probe: master (sourceExamId=null) English Grammar MCQ on P5+P6
// papers — counts overall, by level, and how many are still pending
// elaboration. Helps decide batch sizing.

import { prisma } from "../src/lib/db";

async function main() {
  const P5P6 = [
    { level: { contains: "Primary 5", mode: "insensitive" as const } },
    { level: { contains: "Primary 6", mode: "insensitive" as const } },
    { level: { equals: "P5", mode: "insensitive" as const } },
    { level: { equals: "P6", mode: "insensitive" as const } },
    { level: { equals: "PSLE", mode: "insensitive" as const } },
  ];

  const baseWhere = {
    syllabusTopic: "Grammar MCQ",
    examPaper: {
      sourceExamId: null,            // master question only — NOT a clone
      paperType: null,                // real master papers, not eval/quiz clones
      subject: { contains: "english", mode: "insensitive" as const },
      OR: P5P6,
    },
  } as const;

  const total = await prisma.examQuestion.count({ where: baseWhere });
  const elaborated = await prisma.examQuestion.count({ where: { ...baseWhere, elaboration: { not: null, not: { startsWith: '{"__elabError"' } } } });
  const failed = await prisma.examQuestion.count({ where: { ...baseWhere, elaboration: { startsWith: '{"__elabError"' } } });
  const pending = total - elaborated - failed;
  console.log(`Master Grammar MCQ — P5+P6 only (sourceExamId=null, paperType=null):`);
  console.log(`  total       ${total}`);
  console.log(`  elaborated  ${elaborated}`);
  console.log(`  failed      ${failed}`);
  console.log(`  pending     ${pending}`);

  // Split by level for visibility
  for (const lvl of ["Primary 5", "P5", "Primary 6", "P6", "PSLE"]) {
    const c = await prisma.examQuestion.count({
      where: {
        syllabusTopic: "Grammar MCQ",
        examPaper: {
          sourceExamId: null, paperType: null,
          subject: { contains: "english", mode: "insensitive" },
          level: { equals: lvl, mode: "insensitive" },
        },
      },
    });
    if (c > 0) console.log(`  level=${lvl}: ${c}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
