// Dump questions from Grammar MCQ, Vocab MCQ, Vocab Cloze MCQ, and
// Synthesis sections across 6 years of PSLE English (2019-2024).
// Output: one section per year per file for readability.
import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

const SECTIONS = [
  "Grammar MCQ",
  "Vocabulary MCQ",
  "Vocabulary Cloze MCQ",
  "Synthesis / Transformation",
] as const;

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      title: { startsWith: "PSLE English 20" },
      NOT: { title: { startsWith: "Test Quiz" } },
    },
    select: { id: true, title: true },
    orderBy: { title: "asc" },
  });
  const outDir = path.join(process.cwd(), "scripts", "psle-english-dump");
  fs.mkdirSync(outDir, { recursive: true });

  for (const sec of SECTIONS) {
    const lines: string[] = [`# ${sec} — PSLE 2019-2024\n`];
    for (const p of papers) {
      const yearMatch = p.title.match(/\b(20\d{2})\b/);
      const year = yearMatch?.[1] ?? p.title;
      lines.push(`\n## ${year}\n`);
      const qs = await prisma.examQuestion.findMany({
        where: { examPaperId: p.id, syllabusTopic: sec },
        select: {
          questionNum: true,
          transcribedStem: true,
          transcribedOptions: true,
          answer: true,
        },
        orderBy: { orderIndex: "asc" },
      });
      for (const q of qs) {
        lines.push(`\n**Q${q.questionNum}** (ans: ${q.answer ?? "—"})`);
        lines.push((q.transcribedStem ?? "").trim());
        const opts = q.transcribedOptions as string[] | null;
        if (Array.isArray(opts)) {
          opts.forEach((o, i) => lines.push(`  (${i + 1}) ${o}`));
        }
      }
    }
    const file = path.join(outDir, `${sec.replace(/[\s/]+/g, "-").toLowerCase()}.md`);
    fs.writeFileSync(file, lines.join("\n"));
    console.log(`Wrote ${file}`);
  }
  await prisma.$disconnect();
})();
