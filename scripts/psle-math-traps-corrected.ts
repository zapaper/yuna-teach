// Re-aggregate trap marks using the questionNum-normalised join, so
// Paper 2 trap-tagged questions stop disappearing. Produce two views:
//   1. Overall paper trap marks per year
//   2. Paper 2 only (since most traps live in long-answer OEQs)

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

const TRAP_PATTERNS = [
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
] as const;

function tabulate(papers: Paper[], filterFn: (q: Q) => boolean, label: string) {
  console.log(`\n=== ${label} ===\n`);
  const cols = ["trap", ...papers.map(p => p.year), "AVG"];
  console.log(cols.join("\t"));
  const trapAvgs: Array<{ trap: string; avg: number }> = [];
  for (const trap of TRAP_PATTERNS) {
    const row: string[] = [trap];
    const yearMarks: number[] = [];
    for (const p of papers) {
      const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
      let marks = 0;
      for (const q of p.questions) {
        if (!filterFn(q)) continue;
        const c = classByNum.get(norm(q.questionNum));
        if (c?.traps?.includes(trap)) marks += q.marksAvailable ?? 0;
      }
      yearMarks.push(marks);
      row.push(String(marks));
    }
    const avg = yearMarks.reduce((s, n) => s + n, 0) / yearMarks.length;
    row.push(avg.toFixed(1));
    trapAvgs.push({ trap, avg });
    console.log(row.join("\t"));
  }
  console.log(`\n${label} — 10-year average trap mark weight:\n`);
  trapAvgs.sort((a, b) => b.avg - a.avg);
  const maxAvg = Math.max(...trapAvgs.map(g => g.avg)) || 1;
  for (const { trap, avg } of trapAvgs) {
    const bar = "█".repeat(Math.max(1, Math.round(avg / maxAvg * 40)));
    console.log(`  ${trap.padEnd(36)} ${avg.toFixed(1).padStart(5)}m  ${bar}`);
  }
}

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);
  tabulate(papers, () => true, "OVERALL PAPER trap marks per year (CORRECTED)");
  tabulate(papers, q => /^P2-/.test(q.questionNum), "PAPER 2 ONLY trap marks per year (CORRECTED)");
}

main().catch(e => { console.error(e); process.exit(1); });
