import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: "cmollyyzy0001x91895bkfzha" },
    select: { questions: { orderBy: { orderIndex: "asc" }, select: { id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, sourceQuestionId: true } } },
  });
  const qs = paper?.questions ?? [];
  for (let i = 0; i < qs.length; i++) {
    console.log(`\n=== Q${qs[i].questionNum} (orderIndex ${i}) ===`);
    console.log(`source: ${qs[i].sourceQuestionId}`);
    console.log(`stem: ${JSON.stringify(qs[i].transcribedStem)}`);
    console.log(`opts: ${JSON.stringify(qs[i].transcribedOptions)}`);
  }
  await prisma.$disconnect();
}
main();
