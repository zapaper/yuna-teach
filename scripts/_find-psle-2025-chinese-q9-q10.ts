// Find PSLE 2025 Chinese paper Q9 / Q10 to pull the real MCQ options.

import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      year: "2025",
      subject: { contains: "Chinese", mode: "insensitive" },
      OR: [{ level: "PSLE" }, { title: { contains: "PSLE", mode: "insensitive" } }],
    },
    select: { id: true, title: true, year: true, level: true, examType: true, school: true },
    take: 10,
  });
  console.log(`found ${papers.length} candidate papers`);
  for (const p of papers) {
    console.log(`\n--- ${p.title}  (id=${p.id.slice(0, 12)}…)`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, questionNum: { in: ["9", "10"] } },
      select: {
        questionNum: true, answer: true, marksAvailable: true,
        transcribedStem: true,
        transcribedOptions: true,
        transcribedOptionTable: true,
      },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      console.log(`  Q${q.questionNum}  ans=${q.answer}  marks=${q.marksAvailable}`);
      console.log(`    stem: ${(q.transcribedStem ?? "").slice(0, 120)}`);
      console.log(`    options: ${JSON.stringify(q.transcribedOptions)}`);
      if (q.transcribedOptionTable) console.log(`    optionTable: ${JSON.stringify(q.transcribedOptionTable).slice(0, 200)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
