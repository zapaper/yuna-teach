// Look at English Grammar Cloze questions to design a master class.
// Count, sample stems, and check syllabusTopic / subTopic tagging.

import { prisma } from "../src/lib/db";

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      OR: [
        { syllabusTopic: { contains: "grammar cloze", mode: "insensitive" } },
        { syllabusTopic: { contains: "Grammar Cloze", mode: "insensitive" } },
      ],
      examPaper: { visible: true },
    },
    select: {
      id: true, syllabusTopic: true, subTopic: true, transcribedStem: true, answer: true,
      examPaper: { select: { level: true, paperType: true } },
    },
  });
  console.log(`${qs.length} Grammar Cloze questions in visible papers\n`);

  // Tag fingerprints
  const byTopic = new Map<string, number>();
  for (const q of qs) byTopic.set(q.syllabusTopic ?? "(null)", (byTopic.get(q.syllabusTopic ?? "(null)") ?? 0) + 1);
  console.log("By syllabusTopic:");
  for (const [k, v] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

  const bySub = new Map<string, number>();
  for (const q of qs) bySub.set(q.subTopic ?? "(no sub-topic)", (bySub.get(q.subTopic ?? "(no sub-topic)") ?? 0) + 1);
  console.log("\nBy subTopic:");
  for (const [k, v] of [...bySub.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

  const byLevel = new Map<string, number>();
  for (const q of qs) byLevel.set(q.examPaper.level ?? "(unknown)", (byLevel.get(q.examPaper.level ?? "(unknown)") ?? 0) + 1);
  console.log("\nBy level:");
  for (const [k, v] of [...byLevel.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

  // Show a handful of sample stems so I can see what grammar patterns are tested
  console.log("\nSample 8 stems:");
  for (let i = 0; i < Math.min(8, qs.length); i++) {
    const q = qs[i * Math.floor(qs.length / 8) % qs.length];
    console.log(`  ${q.examPaper.level} Q? stem: ${(q.transcribedStem ?? "").slice(0, 180)}`);
    console.log(`    answer: ${(q.answer ?? "").slice(0, 60)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
