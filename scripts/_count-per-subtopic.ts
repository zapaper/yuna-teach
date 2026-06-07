// Count synthesis questions per sub-topic.

import { prisma } from "../src/lib/db";

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] } },
    select: { subTopic: true, examPaper: { select: { visible: true } } },
  });

  const totals = new Map<string, { total: number; source: number; clones: number }>();
  for (const q of qs) {
    const k = q.subTopic ?? "(untagged / misc)";
    const cur = totals.get(k) ?? { total: 0, source: 0, clones: 0 };
    cur.total++;
    if (q.examPaper.visible) cur.source++; else cur.clones++;
    totals.set(k, cur);
  }

  console.log(`subTopic                       source   clones   total`);
  console.log(`-`.repeat(60));
  for (const [name, c] of [...totals.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`${name.padEnd(30)} ${c.source.toString().padStart(6)} ${c.clones.toString().padStart(8)} ${c.total.toString().padStart(7)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
