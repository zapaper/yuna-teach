import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmonui8ed006b8eod68tn71tr";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, subject: true, sourceExamId: true, metadata: true },
  });
  console.log("paper:", { id: p?.id, title: p?.title, subject: p?.subject, sourceExamId: p?.sourceExamId });
  const meta = p?.metadata as Record<string, unknown> | null;
  const sections = meta?.englishSections as Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | undefined;
  if (sections) {
    console.log(`\n${sections.length} sections:`);
    for (const s of sections) {
      console.log(`  [${s.startIndex}-${s.endIndex}] "${s.label}"  passage=${s.passage ? `${s.passage.length}ch` : "none"}`);
      const labelLower = s.label.toLowerCase();
      if (labelLower.includes("vocab") && labelLower.includes("cloze") && s.passage) {
        console.log(`\n--- VOCAB CLOZE passage (full) ---`);
        console.log(s.passage);
        console.log(`--- END passage ---`);
      }
    }
  }
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, syllabusTopic: { contains: "vocab", mode: "insensitive" } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, orderIndex: true, syllabusTopic: true, transcribedStem: true, transcribedOptions: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true },
  });
  console.log(`\n${qs.length} vocab-tagged questions:`);
  for (const q of qs) {
    console.log(`  Q${q.questionNum} idx=${q.orderIndex} topic="${q.syllabusTopic}"`);
    console.log(`    stem: ${(q.transcribedStem ?? "").slice(0, 100)}`);
    console.log(`    opts: ${JSON.stringify(q.transcribedOptions)?.slice(0, 200)}`);
    console.log(`    answer: ${q.answer}  student: ${q.studentAnswer}  marks: ${q.marksAwarded}/${q.marksAvailable}`);
  }
  await prisma.$disconnect();
})();
