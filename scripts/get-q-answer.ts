import { prisma } from "../src/lib/db";
async function main() {
  const targets = [
    { paperId: "cmpkf6jrh0045k71ouyjjn7di", q: "P2-7", label: "PSLE 2016 QP2-7 (Pattern D)" },
    { paperId: "cmpc6eev50001bg96i6jxx91o", q: "P2-13", label: "PSLE 2021 QP2-13 (Pattern C)" },
    { paperId: "cmpjvf68f0001k71oubxp62rj", q: "27", label: "PSLE 2017 Q27 (Pattern B)" },
  ];
  for (const t of targets) {
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: t.paperId, questionNum: t.q, syllabusTopic: { contains: "Geomet" } },
      select: { questionNum: true, marksAvailable: true, transcribedStem: true, answer: true },
    });
    if (!q) { console.log(`${t.label}: NOT FOUND`); continue; }
    console.log(`\n=== ${t.label} (${q.marksAvailable}m) ===`);
    console.log(`STEM:\n${q.transcribedStem}`);
    console.log(`\nANSWER KEY:\n${q.answer}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
