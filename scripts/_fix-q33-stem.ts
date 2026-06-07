import { prisma } from "../src/lib/db";
async function main() {
  const PAPER = "cmq37j4pf003jrnvdeyrepryo";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, subTopic: "q33-writing" },
    select: { id: true, questionNum: true, transcribedStem: true },
  });
  for (const q of qs) {
    const stripped = (q.transcribedStem ?? "")
      .replace(/^[ 　\t]*_{3,}[ 　\t]*$\r?\n?/gm, "")
      .replace(/\s+$/, "");
    if (stripped === q.transcribedStem) {
      console.log(`Q${q.questionNum}: nothing to strip`);
      continue;
    }
    console.log(`Q${q.questionNum}: stripped ${(q.transcribedStem?.length ?? 0) - stripped.length} chars`);
    console.log(`  after: ${JSON.stringify(stripped.slice(-200))}`);
    await prisma.examQuestion.update({ where: { id: q.id }, data: { transcribedStem: stripped } });
  }
  process.exit(0);
}
main();
