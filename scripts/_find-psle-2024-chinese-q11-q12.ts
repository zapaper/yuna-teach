import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      year: "2024",
      subject: { contains: "Chinese", mode: "insensitive" },
      OR: [{ level: "PSLE" }, { title: { contains: "PSLE", mode: "insensitive" } }],
    },
    select: { id: true, title: true },
    take: 5,
  });
  for (const p of papers) {
    console.log(`\n--- ${p.title}`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, questionNum: { in: ["11", "12"] } },
      select: {
        questionNum: true, answer: true,
        transcribedStem: true,
        transcribedOptions: true,
      },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      console.log(`  Q${q.questionNum}  ans=${q.answer}`);
      console.log(`    stem: ${(q.transcribedStem ?? "").slice(0, 150)}`);
      console.log(`    options: ${JSON.stringify(q.transcribedOptions)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
