// Search exam questions for the magnet-stacking question. Try a few
// keyword combinations since exact wording may differ.

import { prisma } from "../src/lib/db";

async function main() {
  const keywords = [
    ["magnets", "repel"],
    ["magnet", "levitate"],
    ["magnet", "hover"],
    ["like poles", "magnet"],
    ["same pole", "magnet"],
    ["N-pole", "N-pole"],
    ["bar magnet", "stacked"],
    ["bar magnet", "floating"],
    ["floats", "magnet"],
  ];

  for (const [k1, k2] of keywords) {
    const hits = await prisma.examQuestion.findMany({
      where: {
        AND: [
          { transcribedStem: { contains: k1, mode: "insensitive" } },
          { transcribedStem: { contains: k2, mode: "insensitive" } },
        ],
      },
      take: 8,
      select: {
        id: true, questionNum: true, transcribedStem: true,
        examPaper: { select: { title: true, year: true, school: true } },
      },
    });
    if (hits.length === 0) continue;
    console.log(`\n=== "${k1}" + "${k2}" → ${hits.length} matches ===`);
    for (const q of hits) {
      console.log(`  ${q.examPaper.school ?? "?"} ${q.examPaper.year ?? "?"} — ${q.examPaper.title.slice(0, 60)}`);
      console.log(`    Q${q.questionNum}: ${(q.transcribedStem ?? "").slice(0, 220)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
