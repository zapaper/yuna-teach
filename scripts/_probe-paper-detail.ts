import { prisma } from "../src/lib/db";
(async () => {
  const PAPER = process.argv[2];
  if (!PAPER) { console.error("usage: _probe-paper-detail.ts <paperId> [questionCount=10]"); process.exit(1); }
  const limit = Number(process.argv[3] ?? 10);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    select: {
      questionNum: true,
      answer: true,
      studentAnswer: true,
      marksAwarded: true,
      marksAvailable: true,
      markingNotes: true,
      syllabusTopic: true,
      transcribedOptions: true,
    },
    orderBy: { orderIndex: "asc" },
    take: limit,
  });
  for (const q of qs) {
    const opts = q.transcribedOptions as string[] | null;
    const isMcq = Array.isArray(opts) && opts.length === 4;
    console.log(`Q${q.questionNum.padEnd(4)} ${isMcq ? "MCQ" : "OEQ"}  awarded=${q.marksAwarded}/${q.marksAvailable}  key=${(q.answer ?? "").slice(0, 30)}  student=${(q.studentAnswer ?? "(none)").slice(0, 60)}`);
    if (q.markingNotes) console.log(`   notes: ${q.markingNotes.slice(0, 200)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
