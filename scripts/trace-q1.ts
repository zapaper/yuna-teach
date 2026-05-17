import { prisma } from "../src/lib/db";

(async () => {
  const PAPER_ID = "cmor3lvg9002fmsjf9qasvmje";
  const q1 = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: "1" },
    select: { id: true, sourceQuestionId: true, transcribedStem: true, transcribedSubparts: true, answer: true, imageData: true, syllabusTopic: true },
  });
  console.log("Q1 (clone):");
  console.log("  id:", q1?.id);
  console.log("  topic:", q1?.syllabusTopic);
  console.log("  stem:", JSON.stringify(q1?.transcribedStem));
  console.log("  subparts:", JSON.stringify(q1?.transcribedSubparts).slice(0, 200));
  console.log("  answer:", q1?.answer?.slice(0, 200));
  console.log("  imageData length:", q1?.imageData?.length ?? 0);
  console.log("  sourceQuestionId:", q1?.sourceQuestionId);

  if (q1?.sourceQuestionId) {
    const m = await prisma.examQuestion.findUnique({
      where: { id: q1.sourceQuestionId },
      select: { questionNum: true, transcribedStem: true, transcribedSubparts: true, answer: true, syllabusTopic: true, examPaper: { select: { title: true } } },
    });
    console.log("\nMASTER Q (source):");
    console.log("  paper:", m?.examPaper.title);
    console.log("  qNum:", m?.questionNum);
    console.log("  topic:", m?.syllabusTopic);
    console.log("  stem:", JSON.stringify(m?.transcribedStem));
    console.log("  subparts:", JSON.stringify(m?.transcribedSubparts).slice(0, 300));
    console.log("  answer:", m?.answer?.slice(0, 200));
  }
  await prisma.$disconnect();
})();
