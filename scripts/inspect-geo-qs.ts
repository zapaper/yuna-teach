import { prisma } from "../src/lib/db";
async function main() {
  const papers = [
    { year: "2021", paperId: "cmpc6eev50001bg96i6jxx91o" },
    { year: "2016", paperId: "cmpkf6jrh0045k71ouyjjn7di" },
  ];
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.paperId, syllabusTopic: { contains: "Geomet" } },
      select: { questionNum: true, marksAvailable: true, syllabusTopic: true },
      orderBy: [{ pageIndex: "asc" }, { orderIndex: "asc" }],
    });
    console.log(`\n=== PSLE ${p.year} Geometry questions ===`);
    for (const q of qs) console.log(`  ${q.questionNum} (${q.marksAvailable}m)`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
