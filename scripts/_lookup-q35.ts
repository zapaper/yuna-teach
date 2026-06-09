import { prisma } from "../src/lib/db";
(async () => {
  const PAPER = "cmq66nqks004lafidm8wltpyc";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { startsWith: "35" } },
    select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true, syllabusTopic: true, transcribedStem: true, markingNotes: true, studentAnswer: true },
    orderBy: { orderIndex: "asc" },
  });
  for (const q of qs) {
    console.log(`\n--- Q${q.questionNum} (id=${q.id}) ---`);
    console.log(`  marks: ${q.marksAwarded ?? "(null)"} / ${q.marksAvailable}`);
    console.log(`  topic: ${q.syllabusTopic ?? "(none)"}`);
    if (q.transcribedStem) console.log(`  stem:  ${q.transcribedStem.slice(0, 200)}`);
    if (q.studentAnswer) console.log(`  student: ${q.studentAnswer.slice(0, 200)}`);
    if (q.markingNotes) console.log(`  notes: ${q.markingNotes.slice(0, 300)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
