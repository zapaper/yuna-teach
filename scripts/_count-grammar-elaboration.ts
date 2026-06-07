import { prisma } from "../src/lib/db";

async function main() {
  const TOPICS = ["Grammar MCQ", "Grammar Cloze"];
  const LEVELS = ["Primary 5", "Primary 6", "PSLE", "P5", "P6"];
  const all = await prisma.examQuestion.count({
    where: {
      syllabusTopic: { in: TOPICS },
      examPaper: { level: { in: LEVELS }, sourceExamId: null },
    },
  });
  const elabbed = await prisma.examQuestion.count({
    where: {
      syllabusTopic: { in: TOPICS },
      elaboration: { not: null },
      examPaper: { level: { in: LEVELS }, sourceExamId: null },
    },
  });
  console.log("Grammar MCQ + Cloze (P5/P6/PSLE source rows):");
  console.log(`  total       ${all}`);
  console.log(`  elaborated  ${elabbed}`);
  console.log(`  pending     ${all - elabbed}`);
  // Split by topic
  for (const topic of TOPICS) {
    const t = await prisma.examQuestion.count({
      where: { syllabusTopic: topic, examPaper: { level: { in: LEVELS }, sourceExamId: null } },
    });
    const e = await prisma.examQuestion.count({
      where: { syllabusTopic: topic, elaboration: { not: null }, examPaper: { level: { in: LEVELS }, sourceExamId: null } },
    });
    console.log(`  ${topic.padEnd(15)} ${e}/${t}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
