import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // Pull the master too so we can see the original stem template
  const master = await prisma.examQuestion.findUnique({
    where: { id: "cmputwniy007cqm745gr1xaaq" },
    select: { transcribedStem: true, answer: true, marksAvailable: true },
  });
  console.log("── MASTER ──");
  console.log(JSON.stringify(master, null, 2));
  console.log("── CLONE ──");
  const paperId = "cmr013zax0001hr5qcraj7637";
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true, title: true, subject: true, paperType: true, markingStatus: true,
      sourceExamId: true, assignedToId: true,
      questions: {
        orderBy: { questionNum: "asc" },
        where: { questionNum: { in: ["4", "6"] } },
        select: {
          id: true, questionNum: true, transcribedStem: true,
          transcribedOptions: true, answer: true,
          studentAnswer: true, marksAwarded: true, marksAvailable: true,
          markingNotes: true, elaboration: true, sourceQuestionId: true,
          subTopic: true, syllabusTopic: true,
          transcribedSubparts: true,
        },
      },
    },
  });
  console.log(JSON.stringify(paper, null, 2));
  await prisma.$disconnect();
})();
