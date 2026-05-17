import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmor3lvg9002fmsjf9qasvmje";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: {
      id: true, title: true, subject: true, level: true, paperType: true,
      sourceExamId: true, completedAt: true, markingStatus: true, score: true, totalMarks: true,
      metadata: true,
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
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true, transcribedSubparts: true,
      sourceQuestionId: true,
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
    const status = q.marksAwarded === q.marksAvailable && q.marksAvailable !== null ? "✓" : (q.marksAwarded ?? 0) > 0 ? "~" : "✗";
    console.log(`\n${status} Q${q.questionNum} idx=${q.orderIndex} topic="${q.syllabusTopic}" ${isMcq ? "MCQ" : "OEQ"} ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 100)}`);
    if (q.transcribedOptions) console.log(`  opts: ${JSON.stringify(q.transcribedOptions).slice(0, 100)}`);
    console.log(`  student="${(q.studentAnswer ?? "").slice(0, 100)}"`);
    console.log(`  key="${(q.answer ?? "").slice(0, 80)}"`);
    if (q.markingNotes) console.log(`  notes: ${q.markingNotes.slice(0, 200)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
