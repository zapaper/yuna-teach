// Two complementary counts of connector "appearances" per PSLE
// Chinese Paper 2:
//   (a) Questions where the answer key OR options contain a connector
//       — i.e. where connector knowledge is required to answer.
//   (b) Raw word-count of connector tokens across question stems +
//       options + cloze passages (text density signal).

import { prisma } from "../src/lib/db";

const PAPERS = [
  { year: "2016", id: "cmphqli6g002b98jke0olegzj" },
  { year: "2017", id: "cmphphlfd0001ivva0cvmq0du" },
  { year: "2018", id: "cmphqacp9000198jkrd6ambui" },
  { year: "2019", id: "cmparuwvl0001e4lryp826f9w" },
  { year: "2020", id: "cmparv40c0003e4lrg48z2b7v" },
  { year: "2021", id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: "2022", id: "cmp9muf3q00038gvnb269c3ht" },
  { year: "2023", id: "cmp9msmx800018gvnz0suifzq" },
  { year: "2024", id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: "2025", id: "cmphn6npc000112g1sdstau5j" },
];

const CONNECTORS = [
  // single connectors
  "因为", "所以", "由于", "因此", "因而", "既然", "之所以",
  "虽然", "但是", "不过", "可是", "然而", "尽管", "即使", "纵然",
  "如果", "假如", "要是", "倘若", "只要", "只有", "除非", "无论", "不管",
  "不但", "不仅", "而且", "并且", "况且", "甚至", "反而",
  "于是", "便", "才", "却",
  "首先", "然后", "接着", "随后", "最后", "终于",
  "或者", "还是",
  "一边", "一面", "一会儿", "时而",
  "可见", "因此",
  "难道", "究竟",
  // paired sentinels (counted once even if both halves appear)
  "只要……就", "只有……才", "不但……还", "不但……而且", "虽然……但是",
  "如果……就", "即使……也", "尽管……还是",
];

function countAll(text: string | null): { occurrences: number; matched: string[] } {
  if (!text) return { occurrences: 0, matched: [] };
  let total = 0;
  const matched = new Set<string>();
  for (const c of CONNECTORS) {
    // Pair patterns: "X……Y" → match X and Y separately as substrings
    if (c.includes("……")) {
      const [a, b] = c.split("……");
      if (text.includes(a) && text.includes(b)) {
        matched.add(c);
        total += 1; // count the pair as 1 connector
      }
      continue;
    }
    let idx = 0;
    while ((idx = text.indexOf(c, idx)) !== -1) {
      total += 1;
      matched.add(c);
      idx += c.length;
    }
  }
  return { occurrences: total, matched: [...matched] };
}

async function main() {
  console.log("year\tquestions_with_connector\ttotal_connector_word_count\tunique_connectors");
  let agg = { qs: 0, words: 0 };
  for (const { year, id } of PAPERS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { transcribedStem: true, transcribedOptions: true, answer: true },
    });
    let questionsWithConnector = 0;
    let totalWords = 0;
    const uniq = new Set<string>();
    for (const q of qs) {
      const text = [
        q.transcribedStem ?? "",
        ...((q.transcribedOptions as string[] | null) ?? []),
        q.answer ?? "",
      ].join("\n");
      const { occurrences, matched } = countAll(text);
      if (matched.length > 0) questionsWithConnector += 1;
      totalWords += occurrences;
      for (const m of matched) uniq.add(m);
    }
    agg.qs += questionsWithConnector;
    agg.words += totalWords;
    console.log(`${year}\t${questionsWithConnector}\t${totalWords}\t${uniq.size}`);
  }
  console.log("\n=== Averages across 10 years ===");
  console.log(`Avg questions with at least one connector: ${(agg.qs / PAPERS.length).toFixed(1)} per paper`);
  console.log(`Avg total connector tokens (across stems/options/passages): ${(agg.words / PAPERS.length).toFixed(1)} per paper`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
