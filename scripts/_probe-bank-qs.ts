import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: "cmo82pjw3004y12oh6o2ub3kt" },
    select: {
      id: true, questionNum: true,
      transcribedStem: true, transcribedSubparts: true,
      imageData: true, diagramImageData: true,
      sourceQuestionId: true, syntheticGenerated: true, syntheticSkipped: true,
      answer: true, answerImageData: true,
    },
    orderBy: { questionNum: "asc" },
    take: 8,
  });
  for (const q of qs) {
    console.log(`q${q.questionNum} (${q.id})`);
    console.log(`  stem.len=${q.transcribedStem?.length ?? 0}  image.len=${q.imageData?.length ?? 0}  diagram.len=${q.diagramImageData?.length ?? 0}`);
    console.log(`  answer.len=${q.answer?.length ?? 0}  answerImg.len=${q.answerImageData?.length ?? 0}`);
    console.log(`  sourceQuestionId=${q.sourceQuestionId ?? "—"}  syntheticGenerated=${q.syntheticGenerated}  syntheticSkipped=${q.syntheticSkipped}`);
    const subs = q.transcribedSubparts as Array<{label?:string}> | null;
    console.log(`  subparts: ${subs?.length ?? 0}`);
  }
  // How many of the 49 have stems vs empty?
  const all = await prisma.examQuestion.findMany({
    where: { examPaperId: "cmo82pjw3004y12oh6o2ub3kt" },
    select: { transcribedStem: true, imageData: true, sourceQuestionId: true },
  });
  const withStem = all.filter(q => (q.transcribedStem?.length ?? 0) > 0).length;
  const withImage = all.filter(q => (q.imageData?.length ?? 0) > 0).length;
  const withSource = all.filter(q => q.sourceQuestionId).length;
  console.log(`\nAcross all 49:`);
  console.log(`  with transcribedStem: ${withStem}`);
  console.log(`  with imageData:       ${withImage}`);
  console.log(`  with sourceQuestionId: ${withSource}`);
  await prisma.$disconnect();
})();
