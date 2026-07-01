import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const rows = await prisma.examPaper.groupBy({
    by: ["subject", "level"],
    where: { sourceExamId: null, paperType: null, extractionStatus: "ready" },
    _count: { _all: true },
    orderBy: [{ subject: "asc" }, { level: "asc" }],
  });
  console.log(`Master paper counts by (subject, level):`);
  for (const r of rows) console.log(`  ${(r.subject ?? "(null)").padEnd(20)}  L=${r.level ?? "(null)"}  n=${r._count._all}`);
  const englishSample = await prisma.examQuestion.findFirst({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "english", mode: "insensitive" },
      },
      syllabusTopic: "Grammar MCQ",
    },
    select: { transcribedOptions: true, syllabusTopic: true, subTopic: true, examPaper: { select: { level: true, subject: true } } },
  });
  console.log(`\nSample English Grammar MCQ master row:`);
  console.log(JSON.stringify(englishSample, null, 2));
  await prisma.$disconnect();
})();
