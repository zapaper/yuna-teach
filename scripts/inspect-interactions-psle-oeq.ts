import { prisma } from "../src/lib/db";

(async () => {
  // Find PSLE Science papers 2022-2024
  const papers = await prisma.examPaper.findMany({
    where: {
      AND: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { subject: { contains: "science", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, year: true },
    orderBy: { year: "asc" },
  });

  const targetYears = ["2022", "2023", "2024"];
  const target = papers.filter(p => p.year && targetYears.includes(p.year));
  console.log("PSLE Science papers in 2022-2024:");
  for (const p of target) console.log(`  ${p.year}  ${p.title}  (${p.id})`);

  for (const p of target) {
    console.log(`\n=== ${p.year} — ${p.title} ===`);
    const qs = await prisma.examQuestion.findMany({
      where: {
        examPaperId: p.id,
        OR: [
          { masterSubTopic: { contains: "interaction", mode: "insensitive" } },
          { syllabusTopic: { contains: "interaction", mode: "insensitive" } },
        ],
      },
      select: { questionNum: true, transcribedStem: true, marksAvailable: true, syllabusTopic: true, masterSubTopic: true, transcribedOptions: true },
      orderBy: { orderIndex: "asc" },
    });
    const oeq = qs.filter(q => {
      const opts = q.transcribedOptions;
      const hasOpts = Array.isArray(opts) && opts.length > 0;
      return !hasOpts;
    });
    console.log(`  ${oeq.length} OEQ (of ${qs.length} interaction-tagged total)`);
    for (const q of oeq) {
      console.log(`\n  Q${q.questionNum}  ·  ${q.marksAvailable ?? "?"}m  ·  topic=${q.syllabusTopic ?? "—"}  ·  subTopic=${q.masterSubTopic ?? "—"}`);
      const stem = (q.transcribedStem ?? "").slice(0, 600);
      console.log(`    ${stem.replace(/\n/g, "\n    ")}`);
    }
  }
  await prisma.$disconnect();
})();
