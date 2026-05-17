import { prisma } from "../src/lib/db";
(async () => {
  const SOURCE_Q_ID = "cmor0hrtl0003msjfenpfw445";
  const m = await prisma.examQuestion.findUnique({
    where: { id: SOURCE_Q_ID },
    select: { id: true, questionNum: true, examPaperId: true, examPaper: { select: { id: true, title: true, paperType: true, sourceExamId: true } } },
  });
  console.log("source question:", m);

  // Also check what other clones from this paper look like
  if (m?.examPaperId) {
    const allQs = await prisma.examQuestion.findMany({
      where: { examPaperId: m.examPaperId },
      orderBy: { orderIndex: "asc" },
      select: { id: true, questionNum: true, transcribedSubparts: true, answer: true },
    });
    console.log(`\n${allQs.length} questions in ${m.examPaper.title}:`);
    for (const q of allQs) {
      const subs = (q.transcribedSubparts as Array<{label: string; text: string}> | null)?.map(s => `(${s.label})${s.text.slice(0, 30)}`).join(" / ") ?? "(none)";
      console.log(`  Q${q.questionNum} ${q.id}`);
      console.log(`    subs: ${subs.slice(0, 100)}`);
      console.log(`    ans:  "${(q.answer ?? "").slice(0, 70)}"`);
    }
  }
  await prisma.$disconnect();
})();
