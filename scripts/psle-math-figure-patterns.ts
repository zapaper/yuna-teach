// Hunt the "Figure 1, 2, 3 ... → predict figure N" long-OEQ pattern
// questions. These typically: appear in Paper 2, span (a)(b)(c)
// subparts, ask for counts at figure 100 or similar, worth 3-5
// marks. The classifier likely bucketed them as Geometry or
// Statistics, missing the pattern dimension.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  console.log("=== Figure-progression pattern questions (Figure 1/2/3 → Figure N) ===\n");
  let totalCount = 0;
  let totalMarks = 0;

  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [c.questionNum, c]));
    const hits = p.questions.filter(q => {
      const stem = (q.transcribedStem ?? "").toLowerCase();
      // True progression questions name 3+ figures or ask about a
      // figure number ≥10. A 2-figure stem is usually just a "before/
      // after" question, not the "predict Figure 100" archetype.
      const hasThreePlusFigures =
        /figure\s+1\b/.test(stem) &&
        /figure\s+2\b/.test(stem) &&
        /figure\s+3\b/.test(stem);
      const askFarFigure = /figure\s+\d{2,}/.test(stem);   // figure 10+, 100, 50, etc.
      // Also include "1st/2nd/3rd arrangement" / "term" style stems.
      const ordinalProgression =
        /1st (figure|arrangement|term)/.test(stem) &&
        /(2nd|3rd) (figure|arrangement|term)/.test(stem);
      return hasThreePlusFigures || askFarFigure || ordinalProgression;
    });

    if (hits.length === 0) {
      console.log(`${p.year}: —`);
      continue;
    }
    const marks = hits.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    totalCount += hits.length;
    totalMarks += marks;
    console.log(`${p.year}: ${hits.length} question(s), ${marks} marks`);
    for (const q of hits) {
      const c = classByNum.get(q.questionNum);
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 400);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m, tagged: ${c?.topic ?? "?"}): ${stem}`);
    }
    console.log();
  }

  console.log(`Total across 10 years: ${totalCount} questions, ${totalMarks} marks`);
  console.log(`Average per paper: ${(totalCount / 10).toFixed(1)} questions, ${(totalMarks / 10).toFixed(1)} marks`);

  // Also cast a wider net: ANY question with subTopic or stem hinting at
  // figure-progression even if Figure 1 isn't explicit — e.g. "shape A,
  // shape B, shape C".
  console.log(`\n=== Wider net: stems mentioning 'pattern' AND a numbered figure/term ===\n`);
  for (const p of papers) {
    const wider = p.questions.filter(q => {
      const stem = (q.transcribedStem ?? "").toLowerCase();
      if (!/pattern|sequence/.test(stem)) return false;
      if (!/figure|shape|term|row/.test(stem)) return false;
      const isStrong = /\d{2,}\s*(?:th|st|nd|rd)/.test(stem) || /figure\s+\d{2,}/.test(stem);
      return isStrong;
    });
    if (wider.length === 0) continue;
    console.log(`${p.year}:`);
    for (const q of wider) {
      const c = (p.classifications.find(x => x.questionNum === q.questionNum));
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 350);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m, ${c?.topic ?? "?"}): ${stem}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
