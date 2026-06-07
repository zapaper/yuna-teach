// Show every Number Patterns question across 10 years — examples,
// mark weight, and which paper position they sit in.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  console.log("=== Number Pattern questions across 10 years ===\n");
  let totalCount = 0;
  let totalMarks = 0;
  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [c.questionNum, c]));
    const patternQs = p.questions.filter(q => {
      const c = classByNum.get(q.questionNum);
      return c?.topic === "Number Patterns" || c?.traps?.includes("pattern_sequence_finding");
    });
    if (patternQs.length === 0) {
      console.log(`${p.year}: — (no pattern questions)`);
      continue;
    }
    const marks = patternQs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    totalCount += patternQs.length;
    totalMarks += marks;
    console.log(`${p.year}: ${patternQs.length} question(s), ${marks} marks`);
    for (const q of patternQs) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 250);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m): ${stem}`);
    }
    console.log();
  }
  console.log(`Total across 10 years: ${totalCount} questions, ${totalMarks} marks`);
  console.log(`Average per paper: ${(totalCount / 10).toFixed(1)} questions, ${(totalMarks / 10).toFixed(1)} marks`);
}

main().catch(e => { console.error(e); process.exit(1); });
