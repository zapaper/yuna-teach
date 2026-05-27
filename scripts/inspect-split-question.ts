import { prisma } from "../src/lib/db";

// Look for any Science master paper with split-page Q33ab + Q33c (or similar)
// and dump what's stored in each segment.
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      questionNum: { contains: "c", mode: "insensitive" },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
      },
    },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      answer: true, transcribedSubparts: true,
      examPaper: { select: { id: true, title: true } },
    },
    take: 30,
  });
  const splits = qs.filter(q => /^\d+[a-z]+$/i.test(q.questionNum) && q.questionNum.match(/c/i));
  console.log(`Found ${splits.length} split-segment questions ending in c.\n`);
  for (const q of splits.slice(0, 10)) {
    const base = q.questionNum.replace(/[a-z]+$/i, "");
    console.log(`[${q.examPaper.title.slice(0, 40)}] Q${q.questionNum}`);
    console.log(`  answer (raw):       ${(q.answer ?? "").slice(0, 200)}`);
    console.log(`  transcribedStem:    ${(q.transcribedStem ?? "").slice(0, 200)}`);
    console.log(`  subparts:           ${JSON.stringify(q.transcribedSubparts).slice(0, 200)}`);
    // Find the sibling segment(s) for context
    const siblings = await prisma.examQuestion.findMany({
      where: {
        examPaperId: q.examPaper.id,
        questionNum: { startsWith: base },
        id: { not: q.id },
      },
      select: { questionNum: true, answer: true, transcribedStem: true },
    });
    for (const s of siblings) {
      console.log(`  sibling Q${s.questionNum}:`);
      console.log(`    answer: ${(s.answer ?? "").slice(0, 200)}`);
      console.log(`    stem:   ${(s.transcribedStem ?? "").slice(0, 200)}`);
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
