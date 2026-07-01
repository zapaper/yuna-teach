import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "english", mode: "insensitive" },
        level: "PSLE",
        year: { in: ["2014","2015","2016","2017","2018","2019","2020","2021","2022","2023","2024","2025"] },
      },
    },
    select: { subTopic: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.subTopic ?? "(untagged)", (counts.get(r.subTopic ?? "(untagged)") ?? 0) + 1);
  const total = rows.length;
  console.log(`PSLE (level=PSLE) English Grammar MCQ 2014-2025: n=${total}`);
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = (n / total * 100).toFixed(1);
    console.log(`  ${k.padEnd(25)}  n=${n.toString().padStart(3)}  ${pct.padStart(5)}%`);
  }
  await prisma.$disconnect();
})();
