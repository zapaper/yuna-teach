import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmoshbgrb001k13l0xutifd4f";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { questionNum: "asc" },
    select: { questionNum: true, marksAwarded: true, marksAvailable: true, markingNotes: true, canvasData: true, canvasDataSubparts: true, studentAnswer: true },
  });
  for (const q of qs) {
    const cdLen = q.canvasData ? q.canvasData.length : 0;
    const subParts = q.canvasDataSubparts as Record<string,string> | null;
    const subSizes = subParts ? Object.entries(subParts).map(([k,v])=>`${k}:${(v||"").length}`).join(",") : "";
    console.log(`Q${q.questionNum}: ${q.marksAwarded}/${q.marksAvailable}  canvas=${cdLen}  subs={${subSizes}}  notes="${(q.markingNotes||"").slice(0,80)}"`);
  }
  await prisma.$disconnect();
})();
