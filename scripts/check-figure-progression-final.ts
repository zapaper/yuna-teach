// Final pass: search the answer field (which contains the worked
// solution and references Figure 1, 2, 3, etc.) for clear pattern-
// progression questions across 10 years. The answer is the most
// reliable signal — if it says "Figure 5: total = 23" it's a
// progression question regardless of what the stem says.

import { prisma } from "../src/lib/db";

const TARGET_IDS = [
  { year: "2016", id: "cmpkf6jrh0045k71ouyjjn7di" },
  { year: "2017", id: "cmpjvf68f0001k71oubxp62rj" },
  { year: "2018", id: "cmpjs41lz0001gd26r66w0v8h" },
  { year: "2019", id: "cmpjqks9d00jyeplmr3l2i0s4" },
  { year: "2020", id: "cmpcc1qm70001k9ivvjooq54y" },
  { year: "2021", id: "cmpc6eev50001bg96i6jxx91o" },
  { year: "2022", id: "cmpjlj8un00dseplma0mky71q" },
  { year: "2023", id: "cmpjjfakf002veplm4qvcdwxh" },
  { year: "2024", id: "cmpjjgg9q002xeplmp67euvmd" },
  { year: "2025", id: "cmpjbfr0a0001hx5ot7bzhurl" },
];

async function main() {
  let totalCount = 0;
  let totalMarks = 0;
  for (const { year, id } of TARGET_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { questionNum: true, marksAvailable: true, transcribedStem: true, transcribedSubparts: true, answer: true },
      orderBy: { orderIndex: "asc" },
    });

    const hits = qs.filter(q => {
      const ansStem = (
        (q.answer ?? "") + " " +
        (q.transcribedStem ?? "") + " " +
        JSON.stringify(q.transcribedSubparts ?? "")
      ).toLowerCase();
      // Strong signal: answer/subparts mention Figure 4 OR Figure 5 OR a
      // pattern table being filled in. These are the true progression OEQs.
      const figureFour = /figure\s+4\b/.test(ansStem);
      const figureFive = /figure\s+5\b/.test(ansStem);
      const tablePatternAsk = /(complete|fill in) the table/.test(ansStem) &&
        /figure|pattern|arrangement/.test(ansStem);
      return figureFour || figureFive || tablePatternAsk;
    });

    if (hits.length === 0) {
      console.log(`${year}: —`);
      continue;
    }
    for (const q of hits) {
      totalCount++;
      totalMarks += q.marksAvailable ?? 0;
      console.log(`\n${year} Q${q.questionNum} (${q.marksAvailable}m)`);
      console.log(`  STEM: ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      // Find the snippet of the answer that names the pattern.
      const ans = (q.answer ?? "").replace(/\s+/g, " ");
      const idx = ans.toLowerCase().search(/figure\s+(4|5)/);
      if (idx >= 0) {
        console.log(`  ANSWER@figure-N: ${ans.slice(Math.max(0, idx - 60), idx + 200)}`);
      }
    }
  }
  console.log(`\n\nTOTAL across 10 years: ${totalCount} questions, ${totalMarks} marks`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
