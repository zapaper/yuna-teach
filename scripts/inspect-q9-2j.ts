import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = "cmp2j7rqj000ojp6v1rz533lm";
  const paper = await prisma.examPaper.findUnique({ where: { id: PAPER_ID }, select: { title: true, subject: true } });
  console.log("Paper:", paper?.title, paper?.subject);
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: "9" },
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      answer: true, studentAnswer: true,
      marksAwarded: true, marksAvailable: true, markingNotes: true,
      transcribedStem: true, transcribedSubparts: true,
      sourceQuestionId: true,
    },
  });
  if (!q) return console.log("Q9 not found");
  console.log("\nstem:", q.transcribedStem?.slice(0, 300));
  const subs = q.transcribedSubparts as Array<{ label: string; text: string; answer?: string }> | null;
  console.log("\nsubparts:");
  for (const s of subs ?? []) {
    console.log(`  [${s.label}] ${(s.text ?? "").slice(0, 80)}  answer=${s.answer ?? "(none)"}`);
  }
  console.log("\nanswer:", q.answer);
  console.log("studentAnswer:", q.studentAnswer);
  console.log("marks:", q.marksAwarded, "/", q.marksAvailable);
  console.log("\nmarkingNotes:");
  console.log(q.markingNotes);

  if (q.sourceQuestionId) {
    const master = await prisma.examQuestion.findUnique({
      where: { id: q.sourceQuestionId },
      select: { answer: true, transcribedSubparts: true },
    });
    console.log("\n=== MASTER ===");
    console.log("answer:", master?.answer);
    const ms = master?.transcribedSubparts as Array<{ label: string; text: string; answer?: string }> | null;
    for (const s of ms ?? []) {
      console.log(`  [${s.label}] answer=${s.answer ?? "(none)"}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
