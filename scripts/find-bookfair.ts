import { prisma } from "../src/lib/db";

async function main() {
  const matches = await prisma.examQuestion.findMany({
    where: {
      OR: [
        { transcribedStem: { contains: "210 books", mode: "insensitive" } },
        { transcribedStem: { contains: "book fair", mode: "insensitive" } },
      ],
      examPaper: { sourceExamId: null },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      examPaper: {
        select: { id: true, title: true, level: true, subject: true, year: true, examType: true, school: true },
      },
    },
    take: 30,
  });
  console.log(`Found ${matches.length} matching questions:\n`);
  for (const q of matches) {
    const isMcq = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length > 0;
    const stemPreview = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 220);
    console.log(`[${isMcq ? "MCQ" : "OEQ"}] Q${q.questionNum} — paper="${q.examPaper.title}" (${q.examPaper.year ?? "?"} ${q.examPaper.examType ?? "?"} ${q.examPaper.school ?? "?"} P${q.examPaper.level ?? "?"})`);
    console.log(`  examPaperId=${q.examPaper.id} questionId=${q.id}`);
    console.log(`  stem: ${stemPreview}${(q.transcribedStem ?? "").length > 220 ? "…" : ""}`);
    console.log(`  answer: ${q.answer ?? "(none)"}\n`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
