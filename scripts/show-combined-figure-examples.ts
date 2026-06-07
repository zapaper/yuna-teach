// Pull a few representative examples of "combined figure area
// subtraction" trap questions — for a concrete teaching example.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    const hits = p.questions.filter(q => {
      const c = classByNum.get(norm(q.questionNum));
      return c?.traps?.includes("combined_figure_area_subtraction");
    });
    if (hits.length === 0) continue;
    console.log(`\n=== ${p.year} (${hits.length} combined-figure question${hits.length > 1 ? "s" : ""}) ===`);
    for (const q of hits) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 320);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m): ${stem}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
