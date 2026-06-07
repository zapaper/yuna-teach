import { prisma } from "../src/lib/db";
const PAPER = "cmq34sx5b004qgnicjxy3flh6";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { in: ["6", "10"] } },
    select: {
      id: true, questionNum: true,
      marksAvailable: true, marksAwarded: true,
      markingNotes: true, elaboration: true,
      sourceQuestionId: true,
    },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum} (id=${q.id}) ===`);
    console.log(`marks: ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`sourceQuestionId: ${q.sourceQuestionId}`);
    console.log(`markingNotes: ${q.markingNotes ?? "(null)"}`);
    console.log(`elaboration:  ${q.elaboration ?? "(null)"}`);
  }

  // Now check the source questions (the originals in the master papers)
  for (const q of qs) {
    if (!q.sourceQuestionId) continue;
    const src = await prisma.examQuestion.findUnique({
      where: { id: q.sourceQuestionId },
      select: {
        id: true, questionNum: true,
        marksAvailable: true,
        transcribedStem: true, transcribedSubparts: true, answer: true,
        examPaper: { select: { id: true, title: true } },
      },
    });
    if (!src) { console.log(`\nSource ${q.sourceQuestionId} not found`); continue; }
    console.log(`\n--- SOURCE for Q${q.questionNum} ---`);
    console.log(`paper: ${src.examPaper?.title} (${src.examPaper?.id})`);
    console.log(`src questionNum: ${src.questionNum}  marksAvailable: ${src.marksAvailable}`);
    console.log(`stem: ${(src.transcribedStem ?? "").slice(0, 300)}`);
    const sps = src.transcribedSubparts as Array<{label?: string; text?: string}> | null;
    if (Array.isArray(sps)) {
      console.log(`subparts (${sps.length}):`);
      for (const sp of sps) {
        console.log(`  (${sp.label}) ${(sp.text ?? "").slice(0, 200)}`);
      }
    }
    console.log(`answer: ${(src.answer ?? "").slice(0, 300)}`);
  }
  process.exit(0);
}
main();
