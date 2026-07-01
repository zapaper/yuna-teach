import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmqxxlr590001kyi8tze0dzes", questionNum: "1" },
    select: { id: true, questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true, sourceQuestionId: true, imageData: true },
  });
  console.log(JSON.stringify({
    id: q?.id, questionNum: q?.questionNum,
    pageIndex: q?.pageIndex,
    yStartPct: q?.yStartPct, yEndPct: q?.yEndPct,
    xStartPct: q?.xStartPct, xEndPct: q?.xEndPct,
    sourceQuestionId: q?.sourceQuestionId,
    imageDataLen: q?.imageData?.length ?? 0,
  }, null, 2));
  await prisma.$disconnect();
})();
