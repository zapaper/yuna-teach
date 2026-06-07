import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: { title: { contains: "CATHOLIC", mode: "insensitive" }, subject: { contains: "Science", mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!paper) { console.log("no paper"); return; }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id, questionNum: { in: ["1", "2", "3", "5", "6", "9", "10", "12", "15", "17", "22"] } },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, answer: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      transcribedSubparts: true,
    },
  });

  for (const q of qs) {
    console.log(`\n--- Q${q.questionNum} (ans=${q.answer}) ---`);
    console.log(`  stem: ${(q.transcribedStem ?? "(null)").slice(0, 80)}`);
    console.log(`  transcribedOptions:      ${JSON.stringify(q.transcribedOptions)}`);
    console.log(`  transcribedOptionImages: ${JSON.stringify(q.transcribedOptionImages)?.slice(0, 60)}`);
    console.log(`  transcribedOptionTable:  ${JSON.stringify(q.transcribedOptionTable)?.slice(0, 200)}`);
    console.log(`  transcribedSubparts:     ${JSON.stringify(q.transcribedSubparts)?.slice(0, 100)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
