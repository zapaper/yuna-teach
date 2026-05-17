import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmoshbgrb001k13l0xutifd4f";
  const p = await prisma.examPaper.findUnique({ where: { id: ID }, select: { score: true, markingStatus: true, totalMarks: true, title: true } });
  console.log(`"${p?.title}"  score=${p?.score}/${p?.totalMarks}  status=${p?.markingStatus}`);
  await prisma.$disconnect();
})();
