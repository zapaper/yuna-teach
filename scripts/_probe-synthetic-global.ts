import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // Global synthetic counts
  const totalSynth = await prisma.syntheticQuestion.count();
  console.log(`Total SyntheticQuestion rows in DB: ${totalSynth.toLocaleString()}`);
  if (totalSynth > 0) {
    const latest = await prisma.syntheticQuestion.findFirst({
      orderBy: { id: "desc" },
      select: { id: true, sourceQuestionId: true, stem: true, diagramImageData: true },
    });
    if (latest) {
      console.log(`Latest synth: ${latest.id}  source=${latest.sourceQuestionId}  stem.len=${latest.stem?.length ?? 0}  diag.len=${latest.diagramImageData?.length ?? 0}`);
    }
  }
  // Paper metadata for the URL
  const paper = await prisma.examPaper.findUnique({
    where: { id: "cmo82pjw3004y12oh6o2ub3kt" },
    select: { id: true, title: true, subject: true, createdAt: true, extractionStatus: true, sourceExamId: true, paperType: true },
  });
  console.log(`Paper meta:`, JSON.stringify(paper, null, 2));
  await prisma.$disconnect();
})();
