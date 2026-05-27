import { prisma } from "../src/lib/db";
async function main() {
  const ids = ["cmmbbyvs30004qa9yinn3drl6", "cmm5wf91d000ryrxwaddlo6xh", "cmpnkrb4c001hn6wks6oisdiu"];
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: { assignedToId: { in: ids } },
      syllabusTopic: "Comprehension Cloze",
      marksAwarded: { lt: 1 },
      transcribedStem: { not: null },
      studentAnswer: { not: null },
    },
    select: { questionNum: true, answer: true, studentAnswer: true, transcribedStem: true, markingNotes: true, examPaper: { select: { assignedToId: true } } },
    take: 25,
  });
  for (const q of qs) {
    if (!q.transcribedStem || q.transcribedStem.length < 30) continue;
    console.log(`\n--- Q${q.questionNum} | wrote: "${q.studentAnswer}" | correct: "${q.answer}"`);
    console.log(`stem: ${q.transcribedStem.slice(0, 350)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
