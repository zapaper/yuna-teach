import { prisma } from "../src/lib/db";
const ID = process.argv[2] ?? "cmop3fc430012kmag6p1tebja";
(async () => {
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, score: true, completedAt: true, markingStatus: true, metadata: true, totalMarks: true },
  });
  console.log(JSON.stringify(p, null, 2));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
