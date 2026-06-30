import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // The 472 SyntheticQuestion rows — how many have diagrams?
  const all = await prisma.syntheticQuestion.findMany({
    select: { id: true, sourceQuestionId: true, diagramImageData: true, stem: true },
  });
  const total = all.length;
  const withDiag = all.filter(s => (s.diagramImageData?.length ?? 0) > 0).length;
  const withStem = all.filter(s => (s.stem?.length ?? 0) > 0).length;
  console.log(`SyntheticQuestion rows: ${total}`);
  console.log(`  with diagramImageData: ${withDiag}`);
  console.log(`  with stem text:        ${withStem}`);

  // Of the masters the synthetic rows derive from, how many have diagrams?
  const masterIds = [...new Set(all.map(s => s.sourceQuestionId).filter((x): x is string => !!x))];
  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: masterIds } },
    select: { id: true, diagramImageData: true },
  });
  const mWithDiag = masters.filter(m => (m.diagramImageData?.length ?? 0) > 0).length;
  console.log(`\nMasters they derive from: ${masters.length}`);
  console.log(`  master has diagramImageData: ${mWithDiag}`);

  // Specifically: of synth rows whose MASTER has a diagram, how many propagated?
  const mDiagMap = new Map(masters.map(m => [m.id, (m.diagramImageData?.length ?? 0) > 0]));
  const synthsFromDiagMasters = all.filter(s => s.sourceQuestionId && mDiagMap.get(s.sourceQuestionId));
  const propagated = synthsFromDiagMasters.filter(s => (s.diagramImageData?.length ?? 0) > 0).length;
  console.log(`\nSynth rows whose MASTER has a diagram: ${synthsFromDiagMasters.length}`);
  console.log(`  ↳ synth row carries the diagram: ${propagated}`);
  console.log(`  ↳ synth row missing the diagram: ${synthsFromDiagMasters.length - propagated}`);
  await prisma.$disconnect();
})();
