import { prisma } from "../src/lib/db";
(async () => {
  // Master Q1 row id
  const Q1 = await prisma.examQuestion.findUnique({
    where: { id: "cmor0hrtl0003msjfenpfw445" },
    select: { id: true, questionNum: true, examPaperId: true, transcribedStem: true, transcribedSubparts: true, transcribedOptions: true, answer: true, syllabusTopic: true },
  });
  console.log("MASTER Q1 (full):");
  console.log(JSON.stringify(Q1, null, 2));

  // Now look at the new clone's Q1 row
  const cloneQ1 = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmor4c4hs0002hksk5eplsjbf", questionNum: "1" },
    select: { id: true, sourceQuestionId: true, transcribedSubparts: true, transcribedStem: true, answer: true },
  });
  console.log("\nCLONE Q1 in new paper (full subparts):");
  console.log(JSON.stringify(cloneQ1, null, 2));
  await prisma.$disconnect();
})();
