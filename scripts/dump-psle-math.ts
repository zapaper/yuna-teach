import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

// Pull the 10 official PSLE Math papers (2016-2025) and dump their
// questions to a single JSON for trend analysis. Use the canonical
// non-"Test Quiz" rows only (one per year, matched by exact year).

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
  const papers = await Promise.all(
    TARGET_IDS.map(async ({ year, id }) => {
      const paper = await prisma.examPaper.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          year: true,
          questions: {
            orderBy: { orderIndex: "asc" },
            select: {
              questionNum: true,
              marksAvailable: true,
              syllabusTopic: true,
              subTopic: true,
              transcribedStem: true,
              transcribedOptions: true,
              answer: true,
            },
          },
        },
      });
      return { year, ...paper };
    })
  );

  const outPath = path.join(__dirname, "psle-math-dump.json");
  await fs.writeFile(outPath, JSON.stringify(papers, null, 2));
  console.log(`Wrote ${outPath} (${papers.length} papers)`);

  // Topic-distribution table per year for quick eyeballing.
  console.log("\n=== Topic distribution by year ===");
  const allTopics = new Set<string>();
  for (const p of papers) {
    for (const q of p.questions ?? []) {
      if (q.syllabusTopic) allTopics.add(q.syllabusTopic);
    }
  }
  const topicList = [...allTopics].sort();
  const header = ["topic", ...papers.map(p => p.year)].join("\t");
  console.log(header);
  for (const topic of topicList) {
    const row = [topic];
    for (const p of papers) {
      const count = (p.questions ?? []).filter(q => q.syllabusTopic === topic).length;
      row.push(String(count));
    }
    console.log(row.join("\t"));
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
