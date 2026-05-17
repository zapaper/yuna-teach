import { prisma } from "../src/lib/db";
const ID = process.argv[2];
(async () => {
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: {
      paperType: true, title: true,
      questions: {
        select: {
          questionNum: true, transcribedStem: true, transcribedOptions: true,
          transcribedOptionImages: true, diagramImageData: true, imageData: true,
          sourceQuestionId: true, syllabusTopic: true,
        },
        orderBy: { orderIndex: "asc" },
        take: 3,
      },
    },
  });
  console.log(`paperType: ${p?.paperType}  title: ${p?.title}`);
  for (const q of p?.questions ?? []) {
    console.log(`\n--- Q${q.questionNum} ---`);
    console.log("stem:        ", q.transcribedStem);
    console.log("options:     ", JSON.stringify(q.transcribedOptions));
    const oi = q.transcribedOptionImages as unknown[] | null;
    console.log("optionImages:", Array.isArray(oi) ? oi.map((o) => (o ? `[${String(o).length}ch]` : "null")).join(", ") : oi);
    console.log("diagramImg:  ", q.diagramImageData ? `[${q.diagramImageData.length}ch]` : "null");
    console.log("imageData:   ", q.imageData ? `[${q.imageData.length}ch]` : "null");
    console.log("topic:       ", q.syllabusTopic);
    console.log("sourceQId:   ", q.sourceQuestionId);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
