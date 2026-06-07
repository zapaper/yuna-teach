import { prisma } from "../src/lib/db";

async function main() {
  // Grammar MCQ master pool at P5-P6 level — same scope the batch runner targeted.
  const where = {
    syllabusTopic: "Grammar MCQ",
    examPaper: {
      sourceExamId: null, paperType: null,
      OR: [
        { level: { in: ["P5", "Primary 5", "P6", "Primary 6", "PSLE", "5", "6"] } },
        { title: { contains: "PSLE", mode: "insensitive" as const } },
      ],
    },
  };

  const total = await prisma.examQuestion.count({ where });
  const elaborated = await prisma.examQuestion.count({
    where: { ...where, elaboration: { not: null } },
  });
  const pending = total - elaborated;

  console.log("Grammar MCQ P5-P6 elaboration progress:");
  console.log(`  Total master rows:       ${total}`);
  console.log(`  With elaboration:        ${elaborated}  (${((elaborated / total) * 100).toFixed(1)}%)`);
  console.log(`  Pending:                 ${pending}  (${((pending / total) * 100).toFixed(1)}%)`);

  // Also show level breakdown so we can see which years are missing
  console.log("\nBy paper level:");
  const rows = await prisma.examQuestion.findMany({
    where,
    select: { elaboration: true, examPaper: { select: { level: true, title: true, year: true } } },
  });
  const byLevel = new Map<string, { total: number; done: number }>();
  for (const r of rows) {
    const key = r.examPaper.level ?? "?";
    const cur = byLevel.get(key) ?? { total: 0, done: 0 };
    cur.total++;
    if (r.elaboration) cur.done++;
    byLevel.set(key, cur);
  }
  for (const [lv, v] of [...byLevel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${lv.padEnd(15)}  ${v.done}/${v.total}  (${((v.done / v.total) * 100).toFixed(1)}%)`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
