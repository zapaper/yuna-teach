import { prisma } from "../src/lib/db";
(async () => {
  const PAPER_ID = "cmor3lvg9002fmsjf9qasvmje";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { createdAt: true, updatedAt: true, title: true },
  });
  console.log(`Test quiz "${paper?.title}"`);
  console.log(`  created: ${paper?.createdAt.toISOString()}`);
  console.log(`  updated: ${paper?.updatedAt.toISOString()}`);

  const masterPaper = await prisma.examPaper.findFirst({
    where: { title: "PSLE Life Science OEQ 2022-2024", paperType: null },
    select: { id: true, createdAt: true, updatedAt: true },
  });
  console.log(`\nMaster paper`);
  console.log(`  created: ${masterPaper?.createdAt.toISOString()}`);
  console.log(`  updated: ${masterPaper?.updatedAt.toISOString()}`);

  // Are there other "Test Quiz" siblings? Check if their Q1 has the same wrong content.
  const siblings = await prisma.examPaper.findMany({
    where: { title: "Test Quiz — PSLE Life Science OEQ 2022-2024" },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  console.log(`\n${siblings.length} test-quiz siblings (oldest first):`);
  for (const s of siblings) {
    const q1 = await prisma.examQuestion.findFirst({
      where: { examPaperId: s.id, questionNum: "1" },
      select: { transcribedSubparts: true, answer: true },
    });
    const subFirst = (q1?.transcribedSubparts as Array<{text: string}> | null)?.[0]?.text?.slice(0, 50) ?? "(none)";
    console.log(`  ${s.id} created=${s.createdAt.toISOString()}`);
    console.log(`    Q1 sub: "${subFirst}"`);
    console.log(`    Q1 ans: "${(q1?.answer ?? "").slice(0, 50)}"`);
  }
  await prisma.$disconnect();
})();
