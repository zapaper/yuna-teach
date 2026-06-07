// Two-part report:
// 1. Is the LAST question always the highest-mark question? Show
//    per-year: last Q's marks vs the max marks anywhere in the paper.
// 2. Show 2-3 candidate "multi-domain" questions from recent years —
//    pick the highest-mark questions where the stem clearly spans 2+
//    skill areas. Used for parent-facing examples.

import { promises as fs } from "fs";
import path from "path";

type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[] };

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-dump.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  console.log("=== Is the last question always the highest-mark? ===\n");
  console.log("year  lastQ#  lastMarks  maxMarks  maxQ#s");
  for (const p of papers) {
    const qs = p.questions ?? [];
    if (qs.length === 0) continue;
    const last = qs[qs.length - 1];
    const maxMarks = qs.reduce((m, q) => Math.max(m, q.marksAvailable ?? 0), 0);
    const maxQs = qs.filter(q => (q.marksAvailable ?? 0) === maxMarks).map(q => q.questionNum).join(",");
    const lastM = last.marksAvailable ?? 0;
    const flag = lastM === maxMarks ? "✓" : `✗ (last=${lastM}, max=${maxMarks})`;
    console.log(`${p.year}  ${last.questionNum.padEnd(7)} ${String(lastM).padEnd(10)} ${String(maxMarks).padEnd(9)} ${maxQs}  ${flag}`);
  }

  console.log("\n=== Last 3 questions per paper (the typical 'killers') ===\n");
  for (const p of papers.slice(-4)) { // last 4 years
    console.log(`--- ${p.year} ---`);
    const last3 = (p.questions ?? []).slice(-3);
    for (const q of last3) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 280);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m): ${stem}`);
    }
    console.log();
  }

  console.log("\n=== Candidate multi-domain killers (5-mark questions from 2023-2025) ===\n");
  for (const p of papers.slice(-3)) {
    const fiveMark = (p.questions ?? []).filter(q => (q.marksAvailable ?? 0) >= 4);
    if (fiveMark.length === 0) continue;
    console.log(`--- ${p.year} (${fiveMark.length} ≥4-mark questions) ---`);
    for (const q of fiveMark) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 400);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m): ${stem}`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
