// Pull the FULL question record (including transcribedSubparts +
// markingNotes + answer) for the candidate progression questions
// to see if the "predict figure N" ask is inside a subpart that
// didn't make it into the truncated stem.

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
  for (const { year, id } of TARGET_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: {
        questionNum: true,
        marksAvailable: true,
        transcribedStem: true,
        transcribedSubparts: true,
        answer: true,
      },
      orderBy: { orderIndex: "asc" },
    });

    const hits = qs.filter(q => {
      // Cast a broad "long pattern OEQ" net using stem + subparts + answer.
      const blob = JSON.stringify([
        q.transcribedStem ?? "",
        q.transcribedSubparts ?? "",
        q.answer ?? "",
      ]).toLowerCase();
      // 3+ figures, OR far-figure ask (figure 10..999), OR ordinal
      // arrangement language, OR "table of figure / arrangement /
      // term counts".
      const hasThreePlusFigures =
        /figure\s+1\b/.test(blob) &&
        /figure\s+2\b/.test(blob) &&
        /figure\s+3\b/.test(blob);
      const askFarFigure = /(figure|arrangement|pattern|term)\s+(\d{2,})/i.test(blob);
      const ordinalProg = /(1st|first|2nd|second|3rd|third)\s+(arrangement|figure|term|pattern|row)/.test(blob)
        && /(arrangement|figure|term|pattern|row)/.test(blob);
      return hasThreePlusFigures || askFarFigure || ordinalProg;
    });

    if (hits.length === 0) {
      console.log(`${year}: —`);
      continue;
    }
    console.log(`\n=== ${year} ===`);
    for (const q of hits) {
      console.log(`\nQ${q.questionNum} (${q.marksAvailable}m)`);
      console.log(`  STEM: ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
      if (q.transcribedSubparts) {
        const sp = JSON.stringify(q.transcribedSubparts).slice(0, 500);
        console.log(`  SUBPARTS: ${sp}`);
      }
      if (q.answer) {
        console.log(`  ANSWER: ${(q.answer ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
