// Probe: does the specific diagnostic quiz's questions have
// elaboration wired up? User reports the review page isn't
// auto-showing the AI explanation.

import { prisma } from "@/lib/db";

const PAPER_ID = "cmr20vzz1001411j5f3826ekq";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true, paperType: true, markingStatus: true },
  });
  console.log("Paper:", paper);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      marksAwarded: true, marksAvailable: true,
      elaboration: true, sourceQuestionId: true,
      transcribedOptions: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\nQuestions on paper: ${qs.length}`);
  for (const q of qs) {
    const gotWrong = q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded < q.marksAvailable;
    const isMcq = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length >= 2;
    const cloneHasElab = !!(q.elaboration && q.elaboration.length > 20);
    let masterHasElab = false;
    if (q.sourceQuestionId) {
      const master = await prisma.examQuestion.findUnique({
        where: { id: q.sourceQuestionId },
        select: { elaboration: true },
      });
      masterHasElab = !!(master?.elaboration && master.elaboration.length > 20);
    }
    console.log(
      `Q${q.questionNum}  ${q.syllabusTopic ?? "?"}  ${q.marksAwarded ?? "-"}/${q.marksAvailable ?? "-"}  wrong=${gotWrong}  mcq=${isMcq}  cloneElab=${cloneHasElab}  masterElab=${masterHasElab}`
    );
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
