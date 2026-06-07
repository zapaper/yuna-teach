// For every combined-figure-tagged question, classify whether the
// figure involves circles (full / semi / quarter) vs purely
// rectilinear shapes. Resolves whether "combined figure area" is
// effectively a "circles in disguise" trap or also includes
// rectangle/triangle decomposition.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  let circleMarks = 0;
  let rectilinearMarks = 0;
  const circleHits: string[] = [];
  const rectilinearHits: string[] = [];

  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    for (const q of p.questions) {
      const c = classByNum.get(norm(q.questionNum));
      if (!c?.traps?.includes("combined_figure_area_subtraction")) continue;
      const stem = (q.transcribedStem ?? "").toLowerCase();
      const hasCircle = /(circles?|semi-?circles?|quarter[ -]?circles?|circular|\\pi|π|radius|radii|diameter)/i.test(stem);
      const tag = `${p.year} Q${q.questionNum} (${q.marksAvailable}m)`;
      if (hasCircle) {
        circleMarks += q.marksAvailable ?? 0;
        circleHits.push(tag);
      } else {
        rectilinearMarks += q.marksAvailable ?? 0;
        rectilinearHits.push(`${tag}: ${stem.slice(0, 160)}`);
      }
    }
  }

  console.log(`=== Combined-figure trap: circles vs rectilinear (10 years) ===\n`);
  console.log(`With CIRCLES (semicircle / quarter circle / full circle): ${circleHits.length} questions, ${circleMarks} marks`);
  for (const h of circleHits) console.log(`  ${h}`);
  console.log(`\nRECTILINEAR ONLY (rectangles / triangles / squares only): ${rectilinearHits.length} questions, ${rectilinearMarks} marks`);
  for (const h of rectilinearHits) console.log(`  ${h}`);

  const total = circleMarks + rectilinearMarks;
  console.log(`\nProportion: ${circleMarks}/${total} = ${((circleMarks / total) * 100).toFixed(0)}% involve circles`);
}

main().catch(e => { console.error(e); process.exit(1); });
