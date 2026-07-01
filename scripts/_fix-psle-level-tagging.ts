import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const targets = ["PSLE English 2023", "PSLE English 2025"];
  const rows = await prisma.examPaper.findMany({
    where: { title: { in: targets }, sourceExamId: null, paperType: null },
    select: { id: true, title: true, level: true, year: true },
  });
  for (const r of rows) {
    if (r.level === "PSLE") { console.log(`  ${r.title} already level=PSLE — skip`); continue; }
    await prisma.examPaper.update({ where: { id: r.id }, data: { level: "PSLE" } });
    console.log(`  ${r.title} (${r.id}): level "${r.level}" → "PSLE"`);
  }
  await prisma.$disconnect();
})();
