import { prisma } from "../src/lib/db";
(async () => {
  const count = await prisma.chineseSupplementaryPaper.count();
  console.log("chinese_supplementary_papers rows:", count);
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    select: { year: true, status: true, pdfPath: true, paper1Text: true, paper3Text: true },
    orderBy: { year: "desc" },
  });
  for (const r of rows) {
    console.log(`  ${r.year} status=${r.status} pdf=${r.pdfPath ? "yes" : "no"} p1=${r.paper1Text ? r.paper1Text.length : 0}c p3=${r.paper3Text ? r.paper3Text.length : 0}c`);
  }
  await prisma.$disconnect();
})();
