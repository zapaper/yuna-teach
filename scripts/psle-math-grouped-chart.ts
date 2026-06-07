// Re-aggregate the classified data WITHOUT the questionNum-prefix bug,
// then produce two grouped views:
//   1. Overall paper (all 100 marks)
//   2. Paper 2 only (long-answer killers, ~55 marks)
// Groupings per user request:
//   - Fractions + Ratio + Percentage (proportional reasoning)
//   - Area & Perimeter + Volume of Cuboid
//   - Measurement + Speed
//   - Geometry (alone)
//   - Statistics (alone)
//   - Whole Numbers + Decimals
//   - Algebra + Number Patterns

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

// Strip any leading "Q" from a questionNum — the classifier prompt
// prefixed everything with "Q" and Gemini echoed it back, while the
// source dump stores raw "P2-1" etc. Normalising both sides fixes
// the join.
const norm = (s: string) => s.replace(/^Q/, "");

const GROUPS: Record<string, string[]> = {
  "Fractions, Ratio, Percentage": ["Fractions", "Ratio", "Percentage"],
  "Whole Numbers + Decimals": ["Whole Numbers", "Decimals"],
  "Geometry": ["Geometry"],
  "Measurement + Speed": ["Measurement", "Speed"],
  "Area + Volume": ["Area & Perimeter", "Volume of Cuboid"],
  "Statistics": ["Statistics"],
  "Algebra + Patterns": ["Algebra", "Number Patterns"],
};

function tabulate(papers: Paper[], filterFn: (q: Q) => boolean, label: string) {
  console.log(`\n=== ${label} ===\n`);
  // Header.
  const cols = ["topic group", ...papers.map(p => p.year), "AVG"];
  console.log(cols.join("\t"));

  // Per-group rows.
  const groupAvgs: Array<{ group: string; avg: number }> = [];
  for (const [groupName, topics] of Object.entries(GROUPS)) {
    const row: string[] = [groupName];
    const yearMarks: number[] = [];
    for (const p of papers) {
      const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
      let marks = 0;
      for (const q of p.questions) {
        if (!filterFn(q)) continue;
        const c = classByNum.get(norm(q.questionNum));
        if (c && topics.includes(c.topic)) marks += q.marksAvailable ?? 0;
      }
      yearMarks.push(marks);
      row.push(String(marks));
    }
    const avg = yearMarks.reduce((s, n) => s + n, 0) / yearMarks.length;
    row.push(avg.toFixed(1));
    groupAvgs.push({ group: groupName, avg });
    console.log(row.join("\t"));
  }

  // Total per year (should match real paper total).
  const totalRow: string[] = ["TOTAL classified"];
  let totalSum = 0;
  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    let t = 0;
    for (const q of p.questions) {
      if (!filterFn(q)) continue;
      const c = classByNum.get(norm(q.questionNum));
      if (c) t += q.marksAvailable ?? 0;
    }
    totalRow.push(String(t));
    totalSum += t;
  }
  totalRow.push((totalSum / papers.length).toFixed(1));
  console.log(totalRow.join("\t"));

  // Sanity: actual total of marks under the filter (whether classified or not).
  const realTotalRow: string[] = ["ACTUAL marks"];
  let realSum = 0;
  for (const p of papers) {
    let t = 0;
    for (const q of p.questions) if (filterFn(q)) t += q.marksAvailable ?? 0;
    realTotalRow.push(String(t));
    realSum += t;
  }
  realTotalRow.push((realSum / papers.length).toFixed(1));
  console.log(realTotalRow.join("\t"));

  // ASCII bar chart of 10-year average per group.
  console.log(`\n${label} — 10-year average mark weighting per group:\n`);
  groupAvgs.sort((a, b) => b.avg - a.avg);
  const maxAvg = Math.max(...groupAvgs.map(g => g.avg));
  for (const { group, avg } of groupAvgs) {
    const bar = "█".repeat(Math.max(1, Math.round(avg / maxAvg * 40)));
    console.log(`  ${group.padEnd(32)} ${avg.toFixed(1).padStart(5)}m  ${bar}`);
  }
}

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  // Overall paper view.
  tabulate(papers, () => true, "OVERALL PAPER (all questions)");

  // Paper 2 only. Paper 2 questions have questionNum starting with "P2-".
  tabulate(papers, q => /^P2-/.test(q.questionNum), "PAPER 2 ONLY (long-answer killers)");
}

main().catch(e => { console.error(e); process.exit(1); });
