import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const q = await prisma.examQuestion.findUnique({
    where: { id: "cmr0oo3pu001vb307r56o2smf" },
    select: {
      id: true, questionNum: true,
      pageIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true,
      transcribedSubparts: true,
      studentAnswer: true, answerImageData: true,
      examPaper: { select: { id: true, paperType: true, title: true, sourceExamId: true } },
    },
  });
  console.log(JSON.stringify(q, (k, v) => (typeof v === "string" && v.length > 200 ? `<${v.length} chars>` : v), 2));
  await prisma.$disconnect();
})();
