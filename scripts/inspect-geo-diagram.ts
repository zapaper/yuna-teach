import { prisma } from "../src/lib/db";
async function main() {
  const targets = [
    { year: "2020", paperId: "cmpcc1qm70001k9ivvjooq54y", q: "23" },
    { year: "2017", paperId: "cmpjvf68f0001k71oubxp62rj", q: "27" },
    { year: "2021", paperId: "cmpc6eev50001bg96i6jxx91o", q: "P2-13" },
    { year: "2016", paperId: "cmpkf6jrh0045k71ouyjjn7di", q: "P2-7" },
    { year: "2022", paperId: "cmpjlj8un00dseplma0mky71q", q: "13" },
  ];
  for (const t of targets) {
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: t.paperId, questionNum: t.q, syllabusTopic: { contains: "Geomet" } },
      select: {
        questionNum: true,
        marksAvailable: true,
        diagramImageData: true,
        diagramBounds: true,
        imageData: true,
      },
    });
    if (!q) { console.log(`${t.year} Q${t.q}: NOT FOUND`); continue; }
    const hasDiagram = !!q.diagramImageData;
    const bounds = q.diagramBounds as { top?: number; left?: number; bottom?: number; right?: number } | null;
    console.log(`${t.year} Q${q.questionNum} (${q.marksAvailable}m):`);
    console.log(`  imageData bytes: ${q.imageData?.length ?? 0}`);
    console.log(`  diagramImageData: ${hasDiagram ? "YES (" + (q.diagramImageData?.length ?? 0) + " chars)" : "NO"}`);
    console.log(`  diagramBounds: ${bounds ? JSON.stringify(bounds) : "null"}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
