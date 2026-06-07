import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmpl06wni008t4u6fcwg62i58";
  const p = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, paperType: true, sourceExamId: true, metadata: true, subject: true },
  });
  console.log("PAPER:", JSON.stringify(p, null, 2));
  if (!p) return;
  const q13 = await prisma.examQuestion.findFirst({
    where: { examPaperId: p.id, questionNum: "13" },
    select: {
      id: true, questionNum: true, syllabusTopic: true, subTopic: true,
      transcribedStem: true, answer: true, elaboration: true, sourceQuestionId: true,
      transcribedOptions: true,
    },
  });
  console.log("Q13 ON CLONE:", JSON.stringify(q13, null, 2));
  if (q13?.sourceQuestionId) {
    const srcQ = await prisma.examQuestion.findUnique({
      where: { id: q13.sourceQuestionId },
      select: {
        id: true, questionNum: true, elaboration: true,
        transcribedStem: true, answer: true, examPaperId: true,
      },
    });
    console.log("SOURCE Q:", JSON.stringify(srcQ, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
