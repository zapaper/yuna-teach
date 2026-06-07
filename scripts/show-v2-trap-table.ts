// Print the strict v2 trap mark table from the existing
// psle-math-classified-v2.json (no Gemini calls).

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null };
type Paper = { year: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");
const TRAPS = [
  "before_after_ratio_change",
  "remaining_of_remaining_fraction",
  "unit_conversion_mid_problem",
  "equalisation_or_equal_remainder",
  "pattern_sequence_finding",
  "folded_paper_geometry",
  "painted_cube_surface_area",
  "multi_stage_speed_or_meeting",
  "combined_figure_area_subtraction",
  "hidden_equal_quantity_assumption",
];

function tabulate(papers: Paper[], filter: (q: Q) => boolean, label: string) {
  console.log(`\n=== ${label} ===\n`);
  const years = papers.map(p => p.year);
  console.log(["Trap", ...years, "AVG"].join("\t"));
  const rows: Array<{ trap: string; avg: number }> = [];
  for (const trap of TRAPS) {
    const row: string[] = [trap];
    const yearMarks: number[] = [];
    for (const p of papers) {
      const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
      let m = 0;
      for (const q of p.questions) {
        if (!filter(q)) continue;
        const c = classByNum.get(norm(q.questionNum));
        if (c?.traps?.includes(trap)) m += q.marksAvailable ?? 0;
      }
      yearMarks.push(m);
      row.push(String(m));
    }
    const avg = yearMarks.reduce((s, n) => s + n, 0) / yearMarks.length;
    row.push(avg.toFixed(1));
    rows.push({ trap, avg });
    console.log(row.join("\t"));
  }
  console.log(`\n${label} — 10-yr avg ranking:`);
  rows.sort((a, b) => b.avg - a.avg);
  const maxAvg = rows[0].avg || 1;
  for (const { trap, avg } of rows) {
    const bar = "█".repeat(Math.max(1, Math.round((avg / maxAvg) * 40)));
    console.log(`  ${trap.padEnd(36)} ${avg.toFixed(1).padStart(5)}m  ${bar}`);
  }
}

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified-v2.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);
  tabulate(papers, () => true, "OVERALL PAPER trap marks per year (v2 strict)");
  tabulate(papers, q => /^P2-/.test(q.questionNum), "PAPER 2 ONLY trap marks per year (v2 strict)");
}

main().catch(e => { console.error(e); process.exit(1); });
