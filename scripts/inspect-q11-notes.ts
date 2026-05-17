import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmp5kbe1w0001svxg1r1j3dhe", questionNum: "11" },
    select: { transcribedSubparts: true, markingNotes: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, sourceQuestionId: true },
  });
  if (!q) return console.log("not found");
  const subs = q.transcribedSubparts as Array<{ label: string; text: string; answer?: string }> | null;
  console.log("subparts (just labels):", subs?.map(s => `${s.label}: answer=${(s as { answer?: string }).answer ?? "(none)"} text=${s.text?.slice(0, 80)}`).join("\n  "));
  console.log("\nquestion.answer:", q.answer);
  console.log("\nstudentAnswer:", q.studentAnswer);
  console.log("\nmarks:", q.marksAwarded, "/", q.marksAvailable);
  console.log("\nsourceQuestionId:", q.sourceQuestionId);
  console.log("\n=== markingNotes ===");
  console.log(q.markingNotes?.slice(0, 2000));

  if (q.sourceQuestionId) {
    const master = await prisma.examQuestion.findUnique({
      where: { id: q.sourceQuestionId },
      select: { transcribedSubparts: true, answer: true },
    });
    console.log("\n=== MASTER question ===");
    console.log("answer:", master?.answer);
    const ms = master?.transcribedSubparts as Array<{ label: string; text: string; answer?: string }> | null;
    console.log("subparts:", ms?.map(s => `${s.label}: answer=${(s as { answer?: string }).answer ?? "(none)"}`).join("\n  "));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
