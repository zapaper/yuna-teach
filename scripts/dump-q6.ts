// One-shot: dump everything we know about Q6 of a specific paper so
// we can see why the review page shows "Step 1 / Step 2" instead of
// the (a) / (b) expected answer.
//
// Usage:
//   npx tsx scripts/dump-q6.ts cmoybbtn8002nl0ngw7r93t7i 6

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const paperId = process.argv[2];
  const qNum = process.argv[3] ?? "6";
  if (!paperId) {
    console.error("Usage: npx tsx scripts/dump-q6.ts <paperId> [qNum]");
    process.exit(1);
  }

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: paperId, questionNum: qNum },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      answerImageData: true,
      transcribedStem: true,
      transcribedSubparts: true,
      transcribedOptions: true,
      elaboration: true,
      markingNotes: true,
      marksAvailable: true,
      marksAwarded: true,
      studentAnswer: true,
    },
  });

  if (!q) {
    console.log(`No question ${qNum} found for paper ${paperId}.`);
    return;
  }

  const showLong = (s: string | null | undefined, n = 600) =>
    !s ? "(empty)" : s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s;

  console.log(`Question ${q.questionNum} — id=${q.id}`);
  console.log(`Marks: ${q.marksAwarded ?? "?"}/${q.marksAvailable ?? "?"}`);
  console.log("");
  console.log("STEM:");
  console.log(showLong(q.transcribedStem, 400));
  console.log("");
  console.log("SUBPARTS (transcribedSubparts):");
  console.log(JSON.stringify(q.transcribedSubparts, null, 2)?.slice(0, 1000));
  console.log("");
  console.log("ANSWER (expected, what should render as 'Correct Answer'):");
  console.log(showLong(q.answer, 1000));
  console.log("");
  console.log("ANSWER IMAGE:", q.answerImageData ? "(present)" : "(none)");
  console.log("");
  console.log("STUDENT ANSWER:");
  console.log(showLong(q.studentAnswer, 400));
  console.log("");
  console.log("ELABORATION (what 'Explain' shows — may contain 'Step 1', 'Step 2'):");
  console.log(showLong(q.elaboration, 1500));
  console.log("");
  console.log("MARKING NOTES:");
  console.log(showLong(q.markingNotes, 600));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
