// Sanity check: do the per-topic mark sums actually add to 100 per
// paper? If not, find out which questions weren't classified or
// have mark mismatches.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  console.log("year  totalMarks  classifiedMarks  missingMarks  unclassifiedQs");
  for (const p of papers) {
    const totalMarks = p.questions.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const classByNum = new Map(p.classifications.map(c => [c.questionNum, c]));
    let classifiedMarks = 0;
    const unclassified: string[] = [];
    for (const q of p.questions) {
      if (classByNum.has(q.questionNum)) classifiedMarks += q.marksAvailable ?? 0;
      else unclassified.push(`${q.questionNum}(${q.marksAvailable})`);
    }
    console.log(`${p.year}  ${String(totalMarks).padEnd(11)} ${String(classifiedMarks).padEnd(16)} ${String(totalMarks - classifiedMarks).padEnd(13)} ${unclassified.join(",")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
