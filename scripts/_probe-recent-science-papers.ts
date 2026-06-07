// Find recent Science papers where the first-pass extract may have
// mis-classified table/image MCQs. Look for any Q where ans=1-4 but
// stored as OEQ (subparts populated, no options).

import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: { subject: { contains: "Science", mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, title: true, createdAt: true },
  });

  console.log(`scanning ${papers.length} most-recent Science papers\n`);

  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      orderBy: { orderIndex: "asc" },
      select: {
        questionNum: true, answer: true,
        transcribedOptions: true, transcribedOptionImages: true,
        transcribedOptionTable: true, transcribedSubparts: true,
      },
    });
    const mismatches: string[] = [];
    let totalMcqAnswers = 0;
    for (const q of qs) {
      const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      if (!/^[1-4]$/.test(ansNorm)) continue;
      totalMcqAnswers++;
      const hasMcqShape = !!(q.transcribedOptions && (q.transcribedOptions as unknown[]).length > 0)
        || !!q.transcribedOptionTable
        || !!(q.transcribedOptionImages && (q.transcribedOptionImages as unknown[]).length > 0);
      const hasOeqShape = !!(q.transcribedSubparts && (q.transcribedSubparts as unknown[]).length > 0);
      // Was extracted (had something stored) but stored as OEQ instead of MCQ.
      if (hasOeqShape && !hasMcqShape) mismatches.push(q.questionNum);
    }
    const ageStr = `${Math.floor((Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24))}d ago`;
    if (mismatches.length > 0) {
      console.log(`❌ ${p.title} (${ageStr}, id=${p.id.slice(0, 12)}...)`);
      console.log(`   ${mismatches.length}/${totalMcqAnswers} MCQ answers extracted as OEQ: Q${mismatches.join(", Q")}`);
    } else if (totalMcqAnswers > 0) {
      console.log(`✓  ${p.title.padEnd(60)} ${ageStr.padEnd(8)} ${totalMcqAnswers} MCQ answers — all correctly extracted`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
