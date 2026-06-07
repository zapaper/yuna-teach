import { prisma } from "../src/lib/db";

const PAPER = "cmq34sx5b004qgnicjxy3flh6";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, subject: true, score: true, totalMarks: true, markingStatus: true, completedAt: true },
  });
  console.log("Paper:", JSON.stringify(paper, null, 2));

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, orderIndex: true,
      marksAvailable: true, marksAwarded: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      answer: true, studentAnswer: true,
      elaboration: true,
      syllabusTopic: true, subTopic: true,
    },
  });
  console.log(`\n${qs.length} questions:`);
  for (const q of qs) {
    console.log(`\n--- Q${q.questionNum} (idx=${q.orderIndex}) ---`);
    console.log(`marks: ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`stem: ${(q.transcribedStem ?? "").slice(0, 250).replace(/\n/g, " ⏎ ")}${(q.transcribedStem ?? "").length > 250 ? "…" : ""}`);
    if (q.transcribedOptions) console.log(`opts: ${JSON.stringify(q.transcribedOptions).slice(0, 200)}`);
    if (q.transcribedSubparts) console.log(`subparts: ${JSON.stringify(q.transcribedSubparts).slice(0, 400)}`);
    console.log(`answer key: ${(q.answer ?? "").slice(0, 300).replace(/\n/g, " ⏎ ")}`);
    console.log(`student: ${(q.studentAnswer ?? "").slice(0, 300).replace(/\n/g, " ⏎ ")}`);
    if (q.elaboration) console.log(`elaboration: ${q.elaboration.slice(0, 500).replace(/\n/g, " ⏎ ")}${q.elaboration.length > 500 ? "…" : ""}`);
  }
  process.exit(0);
}
main();
