import { prisma } from "../src/lib/db";

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmps3x4mt004l2nr7opoak80p", questionNum: "72" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedSubparts: true, transcribedOptionTable: true, studentAnswer: true, answer: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
  });
  console.log(JSON.stringify(q, null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
