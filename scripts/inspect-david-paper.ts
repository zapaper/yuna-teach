import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmoqkmwxa000pwu99qiiwf74x";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: {
      id: true, title: true, subject: true, level: true, paperType: true,
      sourceExamId: true, assignedToId: true,
      completedAt: true, markingStatus: true, score: true, totalMarks: true,
      createdAt: true, updatedAt: true, metadata: true,
    },
  });
  console.log("paper:", p);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, orderIndex: true, syllabusTopic: true,
      marksAwarded: true, marksAvailable: true,
      studentAnswer: true, answer: true,
      markingNotes: true,
      transcribedOptions: true, transcribedOptionImages: true,
    },
  });
  console.log(`\n${qs.length} questions:`);
  for (const q of qs) {
    const opts = q.transcribedOptions as unknown[] | null;
    const optImgs = q.transcribedOptionImages as unknown[] | null;
    const a = (q.answer ?? "").trim().replace(/[().]/g, "");
    const isMcq =
      (Array.isArray(opts) && opts.length === 4) ||
      (Array.isArray(optImgs) && optImgs.some(o => !!o)) ||
      a === "1" || a === "2" || a === "3" || a === "4";
    const wrong = q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded < q.marksAvailable;
    const marker = wrong ? "✗" : (q.marksAwarded === q.marksAvailable ? "✓" : "?");
    console.log(`  ${marker} Q${q.questionNum} idx=${q.orderIndex}  ${isMcq ? "MCQ" : "OEQ"}  ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`     student="${q.studentAnswer}"  key="${q.answer}"`);
    if (q.markingNotes) console.log(`     notes: ${q.markingNotes.slice(0, 200)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
