import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmp5lbu0i000112v2twocrqn1", questionNum: "15" },
    select: { transcribedSubparts: true, markingNotes: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, sourceQuestionId: true },
  });
  if (!q) return console.log("not found");
  console.log("subparts:", JSON.stringify(q.transcribedSubparts, null, 2).replace(/diagramBase64":\s*"[^"]+"/g, 'diagramBase64": "<base64>"').slice(0, 3000));
  console.log("\nanswer:", q.answer);
  console.log("\nstudentAnswer:", q.studentAnswer);
  console.log("\nmarks:", q.marksAwarded, "/", q.marksAvailable);
  console.log("\n=== FULL markingNotes ===");
  console.log(q.markingNotes);
  console.log("\nsourceQuestionId:", q.sourceQuestionId);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
