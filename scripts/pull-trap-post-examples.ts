// Pull full question + answer text for the top picks for each of
// the 3 social-post traps. Output is structured so the post copy
// can be drafted directly from it.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

const PAPER_IDS: Record<string, string> = {
  "2016": "cmpkf6jrh0045k71ouyjjn7di",
  "2017": "cmpjvf68f0001k71oubxp62rj",
  "2018": "cmpjs41lz0001gd26r66w0v8h",
  "2019": "cmpjqks9d00jyeplmr3l2i0s4",
  "2020": "cmpcc1qm70001k9ivvjooq54y",
  "2021": "cmpc6eev50001bg96i6jxx91o",
  "2022": "cmpjlj8un00dseplma0mky71q",
  "2023": "cmpjjfakf002veplm4qvcdwxh",
  "2024": "cmpjjgg9q002xeplmp67euvmd",
  "2025": "cmpjbfr0a0001hx5ot7bzhurl",
};

const PICKS = [
  // Combined-figure area — pick the most visually iconic
  { trap: "combined_figure_area", year: "2017", q: "P2-18", note: "scalloped rectangle (10 semicircles) — pair them into full circles" },
  { trap: "combined_figure_area", year: "2023", q: "P2-12", note: "6 touching circles, r=7cm — shaded gaps rearrange to a circle" },
  // Unit conversion — pick clearest cm/m and dollars/cents
  { trap: "unit_conversion", year: "2018", q: "24", note: "wire 10.2m, cut 3 pieces of 8cm — answer in metres" },
  { trap: "unit_conversion", year: "2020", q: "25", note: "Mrs Tan oil — 880 ml after 4 days, half bottle after 6 — answer in litres" },
  // Hidden equal-quantity
  { trap: "hidden_equal", year: "2019", q: "13", note: "gold:silver 1:5 vs 1:2, same total stars → find gold fraction" },
  { trap: "hidden_equal", year: "2021", q: "P2-15", note: "Helen and Ivan same total coins" },
];

async function main() {
  const out: Array<{ trap: string; year: string; q: string; marks: number; stem: string; answer: string; note: string }> = [];
  for (const pick of PICKS) {
    const paperId = PAPER_IDS[pick.year];
    const row = await prisma.examQuestion.findFirst({
      where: { examPaperId: paperId, questionNum: pick.q },
      select: { questionNum: true, marksAvailable: true, transcribedStem: true, answer: true, transcribedSubparts: true },
    });
    if (!row) { console.log(`MISSING ${pick.year} Q${pick.q}`); continue; }
    out.push({
      trap: pick.trap,
      year: pick.year,
      q: pick.q,
      marks: row.marksAvailable ?? 0,
      stem: (row.transcribedStem ?? "").replace(/\s+/g, " "),
      answer: (row.answer ?? "").replace(/\s+/g, " "),
      note: pick.note,
    });
  }

  for (const x of out) {
    console.log(`\n=== ${x.trap} :: ${x.year} Q${x.q} (${x.marks} marks) ===`);
    console.log(`NOTE: ${x.note}`);
    console.log(`\nSTEM:\n${x.stem}`);
    console.log(`\nANSWER:\n${x.answer.slice(0, 600)}`);
  }

  // Also save JSON dump for later use.
  await fs.writeFile(
    path.join(__dirname, "trap-post-examples.json"),
    JSON.stringify(out, null, 2),
  );
  console.log(`\nWrote ${path.join(__dirname, "trap-post-examples.json")}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
