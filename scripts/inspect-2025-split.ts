import { prisma } from "../src/lib/db";
async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: {
      sourceExamId: null, paperType: null,
      subject: { contains: "science", mode: "insensitive" },
      year: { contains: "2025" },
    },
    select: { id: true, title: true, year: true },
  });
  if (!paper) { console.log("No 2025 Science paper"); return; }
  console.log(`${paper.title} (${paper.year}) ${paper.id}`);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id, questionNum: { not: undefined } },
    select: { questionNum: true, answer: true, transcribedStem: true, transcribedSubparts: true },
    orderBy: { orderIndex: "asc" },
  });
  // Just the split-segment questions
  const splits = qs.filter(q => /^\d+[a-z]+$/i.test(q.questionNum));
  for (const q of splits) {
    console.log(`\nQ${q.questionNum}`);
    console.log(`  answer:           ${(q.answer ?? "").slice(0, 200)}`);
    console.log(`  transcribedStem:  ${(q.transcribedStem ?? "").slice(0, 200)}`);
    console.log(`  subparts:         ${JSON.stringify((q.transcribedSubparts as Array<{ label: string; text?: string }> | null)?.map(s => `${s.label}: ${(s.text ?? "").slice(0, 80)}`))}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
