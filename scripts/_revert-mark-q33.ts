import { prisma } from "../src/lib/db";
async function main() {
  const PAPER = "cmq37j4pf003jrnvdeyrepryo";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER, subTopic: "q33-writing" },
    select: { id: true, questionNum: true, transcribedStem: true, studentAnswer: true },
  });
  if (!q) { console.log("not found"); process.exit(1); }
  if (q.transcribedStem?.endsWith("___")) {
    console.log("already ends with ___, nothing to do");
    process.exit(0);
  }
  const restored = (q.transcribedStem ?? "") + "\n___";
  await prisma.examQuestion.update({ where: { id: q.id }, data: { transcribedStem: restored } });
  console.log(`Restored Q${q.questionNum} (${q.id}) — last 100 chars: ${JSON.stringify(restored.slice(-100))}`);
  console.log(`Mark's existing studentAnswer preserved: ${q.studentAnswer}`);
  process.exit(0);
}
main();
