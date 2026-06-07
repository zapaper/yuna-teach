// PSLE Chinese 2016-2025 — pull every question, group by Q-number,
// dump the stem + correct answer for trend-spotting.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

const PAPER_IDS = [
  { year: 2016, id: "cmphqli6g002b98jke0olegzj" },
  { year: 2017, id: "cmphphlfd0001ivva0cvmq0du" },
  { year: 2018, id: "cmphqacp9000198jkrd6ambui" },
  { year: 2019, id: "cmparuwvl0001e4lryp826f9w" },
  { year: 2020, id: "cmpexr14i0001zmvgavm7u3k5" },
  { year: 2021, id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: 2022, id: "cmp9muf3q00038gvnb269c3ht" },
  { year: 2023, id: "cmp9msmx800018gvnz0suifzq" },
  { year: 2024, id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: 2025, id: "cmphn6npc000112g1sdstau5j" },
];

const trim = (s: string | null, n = 200): string => (s ?? "").replace(/\s+/g, " ").slice(0, n);

(async () => {
  type Row = { year: number; qn: number; topic: string; stem: string; opts: string[]; ans: string; isMcq: boolean; marks: number };
  const rows: Row[] = [];
  for (const { year, id } of PAPER_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { questionNum: true, syllabusTopic: true, answer: true, transcribedStem: true, transcribedOptions: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      const qn = parseInt((q.questionNum ?? "").replace(/\D/g, ""), 10);
      if (!qn) continue;
      const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
      rows.push({
        year, qn,
        topic: q.syllabusTopic ?? "",
        stem: q.transcribedStem ?? "",
        opts,
        ans: q.answer ?? "",
        isMcq: opts.length === 4,
        marks: q.marksAvailable ?? 0,
      });
    }
  }

  // Group by question number
  const byQn = new Map<number, Row[]>();
  for (const r of rows) {
    const arr = byQn.get(r.qn) ?? [];
    arr.push(r);
    byQn.set(r.qn, arr);
  }

  const out: string[] = [];
  out.push(`# PSLE Chinese 2016-2025 — Per-Question Trend Dump\n`);
  out.push(`For each Q-number, the stem and correct answer across 10 years. Use this to spot patterns.\n`);

  for (let qn = 1; qn <= 40; qn++) {
    const items = byQn.get(qn) ?? [];
    if (items.length === 0) continue;
    out.push(`\n## Q${qn}  (${items.length}/10 years)\n`);
    // sample topics
    const topics = [...new Set(items.map(i => i.topic))];
    out.push(`Topic(s): ${topics.join(" | ")}\n`);
    out.push(`| Year | Marks | Stem (truncated) | Correct |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const r of items.sort((a, b) => a.year - b.year)) {
      const ansMatch = r.ans.match(/[1-4]/);
      const idx = ansMatch ? parseInt(ansMatch[0], 10) - 1 : -1;
      let correctText = "—";
      if (r.isMcq && idx >= 0 && r.opts[idx]) {
        correctText = trim(r.opts[idx], 80);
      } else if (!r.isMcq && r.ans) {
        correctText = trim(r.ans, 80);
      }
      out.push(`| ${r.year} | ${r.marks || "?"} | ${trim(r.stem, 120).replace(/\|/g, "\\|")} | ${correctText.replace(/\|/g, "\\|")} |`);
    }
  }

  const outPath = path.join(__dirname, "..", "..", "documents", "PSLE Chinese 2016-2025 per-question trends.md");
  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  console.log(`Wrote ${outPath} (${rows.length} questions across ${PAPER_IDS.length} papers)`);
  await prisma.$disconnect();
})();
