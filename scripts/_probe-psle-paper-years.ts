import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      subject: { contains: "english", mode: "insensitive" },
      OR: [
        { level: "PSLE" },
        { title: { contains: "PSLE", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, year: true, level: true },
    orderBy: { title: "asc" },
  });
  console.log(`PSLE English master candidates: ${papers.length}`);
  for (const p of papers) {
    const gm = await prisma.examQuestion.count({ where: { examPaperId: p.id, syllabusTopic: "Grammar MCQ" } });
    console.log(`  y="${p.year}"  L="${p.level}"  gm=${gm.toString().padStart(3)}  → ${p.title}`);
  }
  await prisma.$disconnect();
})();
