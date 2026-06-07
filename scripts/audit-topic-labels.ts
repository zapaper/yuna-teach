// Audit the actual topic labels emitted by the classifier vs the
// canonical taxonomy. Catches case drift, plural drift, or new
// labels Gemini invented that the aggregator silently ignored.

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const CANONICAL = new Set([
  "Whole Numbers", "Fractions", "Decimals", "Percentage", "Ratio",
  "Algebra", "Speed", "Measurement", "Geometry", "Area & Perimeter",
  "Volume of Cuboid", "Statistics", "Number Patterns",
]);

const norm = (s: string) => s.replace(/^Q/, "");

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  // 1. Distinct topic strings + count of questions + total marks per label
  const labelStats = new Map<string, { qs: number; marks: number; yearsSeen: Set<string> }>();
  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    for (const q of p.questions) {
      const c = classByNum.get(norm(q.questionNum));
      const label = c?.topic ?? "[NO CLASSIFICATION]";
      const cur = labelStats.get(label) ?? { qs: 0, marks: 0, yearsSeen: new Set<string>() };
      cur.qs += 1;
      cur.marks += q.marksAvailable ?? 0;
      cur.yearsSeen.add(p.year);
      labelStats.set(label, cur);
    }
  }

  console.log("=== Distinct topic labels emitted by classifier ===\n");
  const sorted = [...labelStats.entries()].sort((a, b) => b[1].marks - a[1].marks);
  for (const [label, st] of sorted) {
    const canonical = CANONICAL.has(label) ? "✓" : "✗ NOT IN TAXONOMY";
    console.log(`  ${label.padEnd(35)} ${String(st.marks).padStart(4)}m  ${String(st.qs).padStart(3)}Q  ${st.yearsSeen.size}yrs  ${canonical}`);
  }

  // 2. Show every question currently tagged "Whole Numbers" — verify
  //    they really ARE whole-number questions.
  console.log("\n=== Sample of questions tagged 'Whole Numbers' (2024-2025) ===\n");
  for (const p of papers.slice(-2)) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    const hits = p.questions.filter(q => {
      const c = classByNum.get(norm(q.questionNum));
      return c?.topic === "Whole Numbers";
    });
    console.log(`\n--- ${p.year} (${hits.length} Whole Numbers, ${hits.reduce((s, q) => s + (q.marksAvailable ?? 0), 0)} marks) ---`);
    for (const q of hits) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m): ${stem}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
