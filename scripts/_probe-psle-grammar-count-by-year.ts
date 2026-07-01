import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // Try to find question A with alternate wording
  console.log(`── A. wider search — "trouble" + one of the option words ──`);
  const aHits = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: "Thomas", mode: "insensitive" },
      examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } },
    },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaper: { select: { title: true, year: true } } },
  });
  for (const h of aHits) console.log(`  • ${h.examPaper.title} Q${h.questionNum}: ${h.transcribedStem?.slice(0, 130)}`);
  const aAlt = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: "trouble starting", mode: "insensitive" },
      examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } },
    },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaper: { select: { title: true, year: true } } },
  });
  console.log(`  "trouble starting" hits:`);
  for (const h of aAlt) console.log(`    • ${h.examPaper.title} Q${h.questionNum}: ${h.transcribedStem?.slice(0, 130)}`);

  // Grammar MCQ count per year, ALL PSLE English masters
  console.log(`\n── Grammar MCQ per PSLE English master paper ──`);
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      subject: { contains: "english", mode: "insensitive" },
      OR: [{ level: "PSLE" }, { title: { contains: "PSLE", mode: "insensitive" } }],
    },
    select: { id: true, title: true, year: true, level: true },
    orderBy: [{ year: "asc" }, { title: "asc" }],
  });
  let grandTotal = 0;
  const yearTotals = new Map<string, number>();
  for (const p of papers) {
    const n = await prisma.examQuestion.count({
      where: { examPaperId: p.id, syllabusTopic: "Grammar MCQ" },
    });
    grandTotal += n;
    const y = p.year ?? "?";
    yearTotals.set(y, (yearTotals.get(y) ?? 0) + n);
    console.log(`  y=${(p.year ?? "?").padStart(4)}  ${p.title.padEnd(30)}  Grammar MCQ=${n}`);
  }
  console.log(`\nBy year:`);
  for (const [y, n] of [...yearTotals.entries()].sort()) console.log(`  ${y}  Grammar MCQ=${n}`);
  console.log(`\nGRAND TOTAL Grammar MCQ (all PSLE English master papers): ${grandTotal}`);
  await prisma.$disconnect();
})();
