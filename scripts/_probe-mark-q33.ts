import { prisma } from "../src/lib/db";
const PAPER = "cmq37j4pf003jrnvdeyrepryo";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, subTopic: true, studentAnswer: true, transcribedStem: true },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum} (${q.subTopic}) ===`);
    console.log(`stem (last 200 chars): ${JSON.stringify((q.transcribedStem ?? "").slice(-200))}`);
    console.log(`studentAnswer:`);
    console.log(q.studentAnswer ?? "(null)");
  }
  process.exit(0);
}
main();
