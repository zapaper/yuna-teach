// Pull all 语文应用 MCQ (Booklet A first section) questions from
// PSLE Chinese 2019-2024 for analysis.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, title: true, year: true },
    orderBy: { year: "desc" },
  });

  const paperIds = papers.map(p => p.id);
  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: paperIds },
      syllabusTopic: "语文应用 MCQ",
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      examPaperId: true,
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  const byPaper = new Map<string, typeof questions>();
  for (const q of questions) {
    const arr = byPaper.get(q.examPaperId) ?? [];
    arr.push(q);
    byPaper.set(q.examPaperId, arr);
  }

  // Markdown dump grouped by paper, sorted newest first.
  const outLines: string[] = [];
  outLines.push("# PSLE Chinese 语文应用 MCQ (Section 1) — 2019-2024\n");
  for (const p of papers) {
    const qs = byPaper.get(p.id) ?? [];
    if (qs.length === 0) continue;
    outLines.push(`\n## ${p.year} — ${p.title}  (${qs.length} questions)\n`);
    qs.sort((a, b) => {
      const an = parseInt(a.questionNum ?? "0", 10);
      const bn = parseInt(b.questionNum ?? "0", 10);
      return an - bn;
    });
    for (const q of qs) {
      const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]) : [];
      outLines.push(`### Q${q.questionNum}`);
      outLines.push(`${(q.transcribedStem ?? "").trim().replace(/\s+/g, " ")}`);
      opts.forEach((o, i) => outLines.push(`  (${i + 1}) ${o}`));
      outLines.push(`Answer: ${q.answer ?? "?"}\n`);
    }
  }

  const outPath = path.join(__dirname, "psle-chinese-section1.md");
  fs.writeFileSync(outPath, outLines.join("\n"), "utf8");
  console.log(`Wrote ${outPath} (${questions.length} questions)`);

  // Also a quick console summary of options-shape patterns
  // (single-word vs phrase options) to help spot rule families.
  let singleWordOnly = 0, idiomLooking = 0, allMcqHaveOptions = 0;
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    if (opts.length === 4) allMcqHaveOptions++;
    const lens = opts.map(o => (o ?? "").trim().length);
    if (lens.every(l => l > 0 && l <= 4)) singleWordOnly++;
    if (lens.some(l => l >= 8)) idiomLooking++;
  }
  console.log(`\nOptions shape (across all ${questions.length} qs):`);
  console.log(`  4-option questions: ${allMcqHaveOptions}`);
  console.log(`  Options all <= 4 chars (single-char/word):  ${singleWordOnly}`);
  console.log(`  Some option >= 8 chars (idioms/phrases):    ${idiomLooking}`);

  await prisma.$disconnect();
})();
