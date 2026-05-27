import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2];
const Q_NUM = process.argv[3];

async function main() {
  if (!PAPER_ID || !Q_NUM) { console.error("usage: inspect-q-notes <paperId> <questionNum>"); process.exit(1); }
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: Q_NUM },
    select: {
      questionNum: true, marksAwarded: true, marksAvailable: true,
      transcribedSubparts: true,
      studentAnswer: true,
      markingNotes: true,
      answer: true,
      syllabusTopic: true,
    },
  });
  if (!q) { console.error("Question not found"); process.exit(1); }
  console.log(`Q${q.questionNum}  marksAwarded=${q.marksAwarded}  marksAvailable=${q.marksAvailable}`);
  console.log(`subparts:`, JSON.stringify(q.transcribedSubparts, null, 2));
  console.log(`\nanswer key (full):\n${q.answer}`);
  console.log(`\nstudentAnswer (raw):\n${q.studentAnswer}`);
  console.log(`\nmarkingNotes (raw):\n${q.markingNotes}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
