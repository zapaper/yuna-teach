import { prisma } from "../src/lib/db";

(async () => {
  // Look up all questions in the master paper "PSLE Life Science OEQ 2022-2024".
  const masters = await prisma.examPaper.findMany({
    where: { title: { contains: "PSLE Life Science OEQ", mode: "insensitive" }, sourceExamId: null },
    select: { id: true, title: true, paperType: true },
  });
  console.log("Master papers matching:", masters);
  if (masters.length === 0) return;

  for (const m of masters) {
    console.log(`\n===== ${m.id} | "${m.title}" | type=${m.paperType ?? "null"} =====`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: m.id },
      orderBy: { orderIndex: "asc" },
      select: {
        id: true, questionNum: true, orderIndex: true, syllabusTopic: true,
        transcribedStem: true, transcribedSubparts: true, answer: true,
      },
    });
    console.log(`${qs.length} questions:`);
    for (const q of qs) {
      const subFirst = (q.transcribedSubparts as Array<{label: string; text: string}> | null)?.map(s => `(${s.label})${s.text.slice(0, 30)}`).join(" / ") ?? "(none)";
      console.log(`  Q${q.questionNum} idx=${q.orderIndex} topic="${q.syllabusTopic}"`);
      console.log(`    stem: "${(q.transcribedStem ?? "").slice(0, 60)}"`);
      console.log(`    subs: ${subFirst.slice(0, 120)}`);
      console.log(`    ans:  "${(q.answer ?? "").slice(0, 80)}"`);
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
