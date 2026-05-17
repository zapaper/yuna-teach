import { prisma } from "../src/lib/db";

// One-off: clear the cached AI explanation on the book-fair Q13 OEQ
// (master + clones). Next time someone opens the question the explainer
// route regenerates from scratch using the latest prompt.

const IDS = [
  "cmnpi5qiv001znsjpmt16j221", // master P5 Math WA1 Raffles 2025
  "cmo2dbdfd000szs4kpoitxy0t", // Test Quiz clone
  "cmojzrjgk004sd4vnvn9q8sp7", // P5 Focused: Fractions clone
];

async function main() {
  const before = await prisma.examQuestion.findMany({
    where: { id: { in: IDS } },
    select: { id: true, questionNum: true, elaboration: true, examPaper: { select: { title: true } } },
  });
  for (const q of before) {
    const len = q.elaboration?.length ?? 0;
    console.log(`[before] ${q.id} Q${q.questionNum} "${q.examPaper.title}" elaboration=${len} chars`);
  }
  const result = await prisma.examQuestion.updateMany({
    where: { id: { in: IDS } },
    data: { elaboration: null },
  });
  console.log(`\nCleared ${result.count} elaboration cache entries.`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
