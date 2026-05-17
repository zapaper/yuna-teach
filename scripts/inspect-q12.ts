import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmp5kbe1w0001svxg1r1j3dhe", questionNum: "12" },
    select: { transcribedSubparts: true, markingNotes: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true },
  });
  if (!q) return console.log("not found");
  console.log("subparts:", JSON.stringify(q.transcribedSubparts, null, 2).slice(0, 1000));
  console.log("\nanswer:", q.answer);
  console.log("\nstudentAnswer:", q.studentAnswer);
  console.log("\nmarks:", q.marksAwarded, "/", q.marksAvailable);
  console.log("\n=== markingNotes ===");
  console.log(q.markingNotes);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
