import { prisma } from "../src/lib/db";

// Clears every cached AI elaboration on a paper (clone) AND its
// upstream master questions, so subsequent Explain taps regenerate
// against the latest prompts. Usage:
//   npx tsx scripts/clear-all-elabs.ts <paperId>

(async () => {
  const PAPER_ID = process.argv[2];
  if (!PAPER_ID) {
    console.error("usage: clear-all-elabs.ts <paperId>");
    process.exit(1);
  }
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { id: true, questionNum: true, sourceQuestionId: true, elaboration: true },
    orderBy: { orderIndex: "asc" },
  });
  if (qs.length === 0) { console.error("no questions on that paper"); process.exit(1); }
  let cloneCleared = 0;
  let masterCleared = 0;
  const masterIds = new Set<string>();
  for (const q of qs) {
    if (q.elaboration) {
      await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: null } });
      cloneCleared++;
    }
    if (q.sourceQuestionId) masterIds.add(q.sourceQuestionId);
  }
  if (masterIds.size > 0) {
    const result = await prisma.examQuestion.updateMany({
      where: { id: { in: [...masterIds] } },
      data: { elaboration: null },
    });
    masterCleared = result.count;
  }
  console.log(`paper ${PAPER_ID}:`);
  console.log(`  ${cloneCleared}/${qs.length} clone questions cleared`);
  console.log(`  ${masterCleared} upstream master questions cleared`);
  await prisma.$disconnect();
})();
