import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: "cmom90n670001ceagctd09o0c" },
    select: { questions: { orderBy: { orderIndex: "asc" }, select: { id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, transcribedSubparts: true, answer: true, sourceQuestionId: true } } },
  });
  const qs = paper?.questions ?? [];
  for (const q of qs) {
    if (q.questionNum === "12") {
      console.log(`=== Q${q.questionNum} (sourceQuestionId ${q.sourceQuestionId}) ===`);
      console.log(`stem: ${JSON.stringify(q.transcribedStem)}`);
      console.log(`opts: ${JSON.stringify(q.transcribedOptions)}`);
      console.log(`subparts: ${JSON.stringify(q.transcribedSubparts, null, 2)}`);
      console.log(`answer: ${JSON.stringify(q.answer)}`);
    }
  }
  await prisma.$disconnect();
}
main();
