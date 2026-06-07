// Analyse PSLE Math question stem length over 2016-2025 to confirm
// the "60 → 140 words" claim. Compute per-year:
//   - mean / median / 95th percentile word count
//   - mean stem length per Paper 2 vs Paper 1 questions
//   - sample 3 longest stems per year
// Output a clean table for the social post.

import { promises as fs } from "fs";
import path from "path";

type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[] };

const wordCount = (s: string | null): number => {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(w => w.length > 0).length;
};

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
};

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-dump.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  console.log("=== Stem word counts per year (Math 2016-2025) ===\n");
  console.log("year\tmean\tmedian\tp95\tmax\tp1_mean\tp2_mean");
  const summary: Array<{ year: string; mean: number; median: number; p95: number; max: number; p1Mean: number; p2Mean: number }> = [];
  for (const p of papers) {
    const counts = p.questions.map(q => wordCount(q.transcribedStem));
    const mean = counts.reduce((s, n) => s + n, 0) / counts.length;
    const median = percentile(counts, 0.5);
    const p95 = percentile(counts, 0.95);
    const max = Math.max(...counts);

    const p1Counts = p.questions.filter(q => !/^P2-/.test(q.questionNum)).map(q => wordCount(q.transcribedStem));
    const p2Counts = p.questions.filter(q => /^P2-/.test(q.questionNum)).map(q => wordCount(q.transcribedStem));
    const p1Mean = p1Counts.reduce((s, n) => s + n, 0) / Math.max(1, p1Counts.length);
    const p2Mean = p2Counts.reduce((s, n) => s + n, 0) / Math.max(1, p2Counts.length);

    summary.push({ year: p.year, mean, median, p95, max, p1Mean, p2Mean });
    console.log(`${p.year}\t${mean.toFixed(1)}\t${median}\t${p95}\t${max}\t${p1Mean.toFixed(1)}\t${p2Mean.toFixed(1)}`);
  }

  // Compare first 3 years vs last 3 years
  console.log("\n=== Headline comparison ===\n");
  const old3 = summary.slice(0, 3);
  const new3 = summary.slice(-3);
  const oldMean = old3.reduce((s, r) => s + r.mean, 0) / old3.length;
  const newMean = new3.reduce((s, r) => s + r.mean, 0) / new3.length;
  console.log(`Avg stem length 2016-2018: ${oldMean.toFixed(0)} words`);
  console.log(`Avg stem length 2023-2025: ${newMean.toFixed(0)} words`);
  console.log(`Increase: ${((newMean / oldMean - 1) * 100).toFixed(0)}%`);

  const oldP2 = old3.reduce((s, r) => s + r.p2Mean, 0) / old3.length;
  const newP2 = new3.reduce((s, r) => s + r.p2Mean, 0) / new3.length;
  console.log(`\nPaper 2 mean 2016-2018: ${oldP2.toFixed(0)} words`);
  console.log(`Paper 2 mean 2023-2025: ${newP2.toFixed(0)} words`);

  // 3 longest stems for the recent vs old years
  console.log("\n=== 3 longest stems in 2016 ===");
  const p2016 = papers.find(p => p.year === "2016")!;
  const sorted2016 = [...p2016.questions].sort((a, b) => wordCount(b.transcribedStem) - wordCount(a.transcribedStem)).slice(0, 3);
  for (const q of sorted2016) console.log(`  Q${q.questionNum} (${wordCount(q.transcribedStem)} words): ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200)}`);

  console.log("\n=== 3 longest stems in 2025 ===");
  const p2025 = papers.find(p => p.year === "2025")!;
  const sorted2025 = [...p2025.questions].sort((a, b) => wordCount(b.transcribedStem) - wordCount(a.transcribedStem)).slice(0, 3);
  for (const q of sorted2025) console.log(`  Q${q.questionNum} (${wordCount(q.transcribedStem)} words): ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 280)}`);

  console.log("\n=== Median Paper 2 stem 2016 ===");
  const p2_2016 = p2016.questions.filter(q => /^P2-/.test(q.questionNum));
  const median2016 = [...p2_2016].sort((a, b) => wordCount(a.transcribedStem) - wordCount(b.transcribedStem))[Math.floor(p2_2016.length / 2)];
  console.log(`  ${(median2016?.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 280)}`);

  console.log("\n=== Median Paper 2 stem 2025 ===");
  const p2_2025 = p2025.questions.filter(q => /^P2-/.test(q.questionNum));
  const median2025 = [...p2_2025].sort((a, b) => wordCount(a.transcribedStem) - wordCount(b.transcribedStem))[Math.floor(p2_2025.length / 2)];
  console.log(`  ${(median2025?.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 280)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
