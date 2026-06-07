import { prisma } from "../src/lib/db";

const OLD = ["concession", "cause", "condition", "preference", "participle-having", "inclusion-correlative", "relative-clause"];

async function main() {
  const r = await prisma.examQuestion.updateMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      subTopic: { in: OLD },
    },
    data: { subTopic: null },
  });
  console.log(`Cleared old sub-topic tags on ${r.count} rows.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
