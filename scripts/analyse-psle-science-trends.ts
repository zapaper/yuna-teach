// Topic-frequency analysis comparing pre-2021 (2016-2020) vs 2022-2025
// (2022-2024 bundle + 2025) across PSLE Science questions. The 2022-2024
// bundle pools 3 years of questions into 4 papers — divide by 3 to get a
// per-year-equivalent rate.
//
// Output: a markdown table the deep-dive doc can paste.

import * as fs from "fs";
import * as path from "path";

type Q = { questionNum: string; marksAvailable: number | null; syllabusTopic: string | null; transcribedOptions: unknown; transcribedOptionTable: unknown; answer: string | null };
type Paper = { yearLabel: string; kind: string; id: string; title: string | null; year: string | null; questions: Q[] | null };

const DUMP = path.join(__dirname, "psle-science-dump.json");
const papers: Paper[] = JSON.parse(fs.readFileSync(DUMP, "utf8"));

function topicCount(qs: Q[], topic: string): number {
  return qs.filter(q => (q.syllabusTopic ?? "") === topic).length;
}

function topicMarks(qs: Q[], topic: string): number {
  return qs.filter(q => (q.syllabusTopic ?? "") === topic)
           .reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
}

const allTopics = new Set<string>();
for (const p of papers) for (const q of p.questions ?? []) if (q.syllabusTopic) allTopics.add(q.syllabusTopic);

// Group papers
const pre2021 = papers.filter(p => ["2016", "2017", "2018", "2019", "2020"].includes(p.yearLabel));
const y2021   = papers.filter(p => p.yearLabel === "2021");
const bundle  = papers.filter(p => p.yearLabel === "2022-2024");
const y2025   = papers.filter(p => p.yearLabel === "2025");

const pre2021Q = pre2021.flatMap(p => p.questions ?? []);
const y2021Q   = y2021.flatMap(p => p.questions ?? []);
const bundleQ  = bundle.flatMap(p => p.questions ?? []);
const y2025Q   = y2025.flatMap(p => p.questions ?? []);

const pre2021Years = 5;
const recentYears = 3 + 1; // bundle covers 2022/2023/2024 (3 years) + 2025

console.log(`Pre-2021 (2016-2020): ${pre2021.length} papers, ${pre2021Q.length} questions = ${(pre2021Q.length / pre2021Years).toFixed(1)} q/yr`);
console.log(`2021 transition:      ${y2021.length} paper(s), ${y2021Q.length} questions`);
console.log(`2022-2025 (bundle+25): ${bundle.length + y2025.length} papers, ${bundleQ.length + y2025Q.length} questions = ${((bundleQ.length + y2025Q.length) / recentYears).toFixed(1)} q/yr`);
console.log();

// ─── Table by AVERAGE MARKS per year ──────────────────────────────
type MarksRow = { topic: string; preAvg: number; y2021: number; recentAvg: number; delta: number };
const marksRows: MarksRow[] = [];
for (const topic of [...allTopics].sort()) {
  const preAvg = topicMarks(pre2021Q, topic) / pre2021Years;
  const yr2021 = topicMarks(y2021Q, topic);
  const recentAvg = (topicMarks(bundleQ, topic) + topicMarks(y2025Q, topic)) / recentYears;
  const delta = recentAvg - preAvg;
  marksRows.push({ topic, preAvg, y2021: yr2021, recentAvg, delta });
}
// Sort by recent marks (descending) to show priority order
marksRows.sort((a, b) => b.recentAvg - a.recentAvg);

console.log("\n=== TABLE BY AVERAGE MARKS PER YEAR (recent first) ===\n");
console.log("| Topic | Pre-2021 marks/yr | 2021 | 2022-2025 marks/yr | Δ |");
console.log("|---|---|---|---|---|");
for (const r of marksRows) {
  const sign = r.delta > 0.05 ? "+" : r.delta < -0.05 ? "" : " ";
  const bold = Math.abs(r.delta) >= 2 ? "**" : "";
  console.log(`| ${r.topic} | ${bold}${r.preAvg.toFixed(1)}${bold} | ${r.y2021} | ${bold}${r.recentAvg.toFixed(1)}${bold} | ${bold}${sign}${r.delta.toFixed(1)}${bold} |`);
}

// Totals
const preTotalMarks = pre2021Q.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
const recentTotalMarks = [...bundleQ, ...y2025Q].reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
console.log(`\nTotals: pre-2021 = ${(preTotalMarks / pre2021Years).toFixed(1)} marks/yr; 2022-2025 = ${(recentTotalMarks / recentYears).toFixed(1)} marks/yr.`);

console.log();
console.log("Note: 2022-2024 bundle pools 3 years (122 questions across 4 papers — Life MCQ/OEQ + Physical MCQ/OEQ). Divided by 3 to get per-year-equivalent rate before combining with 2025.");
