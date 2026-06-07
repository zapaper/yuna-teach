import { prisma } from "../src/lib/db";

async function main() {
  // Henry Park 2024 Q28 (magnet on spring) + RGS 2025 Q23 (3 rings)
  for (const where of [
    { school: "HENRY PARK PRIMARY SCHOOL", year: "2024", qnum: "28", subject: "Science" },
    { school: "Raffles Girls' Primary School", year: "2025", qnum: "23", subject: "Science" },
  ]) {
    const paper = await prisma.examPaper.findFirst({
      where: { school: where.school, year: where.year, subject: { contains: where.subject, mode: "insensitive" } },
      select: { id: true, title: true },
    });
    if (!paper) continue;
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: paper.id, questionNum: where.qnum },
      select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, marksAvailable: true },
    });
    if (!q) continue;
    console.log(`\n=== ${paper.title}  Q${q.questionNum}  (${q.marksAvailable}m, ans=${q.answer})`);
    console.log(q.transcribedStem);
    const opts = q.transcribedOptions as string[] | null;
    if (opts) {
      console.log("\nOptions:");
      for (let i = 0; i < opts.length; i++) console.log(`  (${i+1}) ${opts[i]}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
