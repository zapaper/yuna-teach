import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmor4c4hs0002hksk5eplsjbf";
  const p = await prisma.examPaper.findUnique({ where: { id: ID }, select: { title: true, paperType: true, completedAt: true, markingStatus: true, score: true, totalMarks: true, createdAt: true } });
  console.log("paper:", p);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["1", "2", "3", "11"] } },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, sourceQuestionId: true, transcribedStem: true, transcribedSubparts: true, answer: true, marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum} ${q.marksAwarded}/${q.marksAvailable}  src=${q.sourceQuestionId}`);
    const subs = (q.transcribedSubparts as Array<{label: string; text: string}> | null)?.map(s => `(${s.label})${s.text.slice(0, 40)}`).join(" / ") ?? "(none)";
    console.log(`  stem: "${(q.transcribedStem ?? "").slice(0, 80)}"`);
    console.log(`  subs: ${subs.slice(0, 150)}`);
    console.log(`  ans:  "${(q.answer ?? "").slice(0, 80)}"`);
    console.log(`  student: "${(q.studentAnswer ?? "").slice(0, 200)}"`);
    if (q.markingNotes) console.log(`  notes: ${q.markingNotes.slice(0, 300)}`);
  }
  if (qs[0]?.sourceQuestionId) {
    const m = await prisma.examQuestion.findUnique({ where: { id: qs[0].sourceQuestionId }, select: { questionNum: true, transcribedStem: true, transcribedSubparts: true, answer: true } });
    console.log("\n=== MASTER for Q1:");
    const msubs = (m?.transcribedSubparts as Array<{label: string; text: string}> | null)?.map(s => `(${s.label})${s.text.slice(0, 40)}`).join(" / ") ?? "(none)";
    console.log(`  qNum=${m?.questionNum}  stem: "${(m?.transcribedStem ?? "").slice(0, 60)}"`);
    console.log(`  subs: ${msubs.slice(0, 150)}`);
    console.log(`  ans:  "${(m?.answer ?? "").slice(0, 80)}"`);
  }
  await prisma.$disconnect();
})();
