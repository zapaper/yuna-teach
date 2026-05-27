// Pull every Comprehension Cloze question from PSLE English papers in DB.
// Output: blank words + their before/after context so we can see what
// classes of word PSLE tests (verbs / prepositions / linkers / adjectives etc.).
import { prisma } from "../src/lib/db";

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "english", mode: "insensitive" },
        title: { contains: "PSLE", mode: "insensitive" },
      },
      syllabusTopic: "Comprehension Cloze",
      answer: { not: null },
    },
    select: {
      questionNum: true, answer: true, transcribedStem: true,
      examPaper: { select: { year: true } },
    },
    orderBy: [{ examPaper: { year: "desc" } }, { orderIndex: "asc" }],
  });
  console.log(`Total Comp Cloze questions across PSLE: ${qs.length}\n`);
  for (const q of qs) {
    console.log(`[${q.examPaper.year}] Q${q.questionNum.padEnd(4)}  ans=${(q.answer ?? "").slice(0, 30).padEnd(32)}  stem: ${(q.transcribedStem ?? "").slice(0, 100).replace(/\n/g, " ")}`);
  }

  // Also dump every distinct answer word so we can class them.
  const allAnswers = qs.map(q => (q.answer ?? "").trim()).filter(Boolean);
  console.log(`\nDistinct answer words: ${new Set(allAnswers).size}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
