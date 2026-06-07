// Show every question tagged with a given trap + year combination
// so suspicious aggregate marks can be eyeballed.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

const TARGETS: Array<{ year: string; trap: string; label: string }> = [
  { year: "2024", trap: "before_after_ratio_change", label: "2024 before/after ratio change (claimed 17m)" },
  { year: "2021", trap: "unit_conversion_mid_problem", label: "2021 unit conversion mid-problem (claimed 16m)" },
  { year: "2021", trap: "hidden_equal_quantity_assumption", label: "2021 hidden equal-quantity (claimed 13m)" },
  // Also pull good representative examples for the user.
  { year: "2018", trap: "unit_conversion_mid_problem", label: "2018 unit conversion (examples)" },
  { year: "2019", trap: "hidden_equal_quantity_assumption", label: "2019 hidden equal-quantity (examples)" },
];

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  for (const { year, trap, label } of TARGETS) {
    const p = papers.find(x => x.year === year);
    if (!p) continue;
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    const hits = p.questions.filter(q => {
      const c = classByNum.get(norm(q.questionNum));
      return c?.traps?.includes(trap);
    });
    const totalMarks = hits.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    console.log(`\n=== ${label}: ${hits.length} questions, ${totalMarks} marks ===\n`);
    for (const q of hits) {
      const c = classByNum.get(norm(q.questionNum));
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ");
      const truncated = stem.length > 400 ? stem.slice(0, 400) + "..." : stem;
      console.log(`Q${q.questionNum} (${q.marksAvailable}m, topic=${c?.topic})`);
      console.log(`  ${truncated}`);
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
