import { prisma } from "../src/lib/db";

(async () => {
  const PAPER_IDS = [
    "cmor0ghj80001msjf7wzhgkj9",   // PSLE Life Science OEQ 2022-2024
    "cmp6om1q8000nk9u7rabiiju5",   // PSLE Physical Science OEQ 2022-2024
  ];
  for (const pid of PAPER_IDS) {
    const paper = await prisma.examPaper.findUnique({
      where: { id: pid },
      select: { id: true, title: true },
    });
    if (!paper) continue;
    console.log(`\n=== ${paper.title} ===`);
    const qs = await prisma.examQuestion.findMany({
      where: {
        examPaperId: pid,
        OR: [
          { subTopic: { contains: "interaction", mode: "insensitive" } },
          { syllabusTopic: { contains: "interaction", mode: "insensitive" } },
          { syllabusTopic: { contains: "environment", mode: "insensitive" } },
          { subTopic: { contains: "environment", mode: "insensitive" } },
        ],
      },
      select: { questionNum: true, transcribedStem: true, marksAvailable: true, syllabusTopic: true, subTopic: true, transcribedOptions: true },
      orderBy: { orderIndex: "asc" },
    });
    console.log(`Found ${qs.length} interaction/environment-tagged Q.`);
    for (const q of qs) {
      const opts = q.transcribedOptions;
      const isOeq = !Array.isArray(opts) || opts.length === 0;
      console.log(`\nQ${q.questionNum}  ·  ${q.marksAvailable ?? "?"}m  ·  ${isOeq ? "OEQ" : "MCQ"}  ·  topic=${q.syllabusTopic ?? "—"}  ·  sub=${q.subTopic ?? "—"}`);
      const stem = (q.transcribedStem ?? "").slice(0, 500);
      console.log(`  ${stem.replace(/\n/g, "\n  ")}`);
    }
  }
  await prisma.$disconnect();
})();
