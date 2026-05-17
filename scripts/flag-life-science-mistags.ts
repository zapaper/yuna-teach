import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // P6 Life Science MCQ 2022-2024 master
  const PAPER_ID = "cmoqvvp4x005pwu9980mndv8v";
  const SUSPECT_TOPICS = [
    "Water cycle, evaporation, condensation",
    "Plant respiratory and circulatory systems",
  ];

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { in: SUSPECT_TOPICS } },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
    },
    orderBy: { orderIndex: "asc" },
  });

  console.log(`P6 Life Science MCQ 2022-2024 — ${qs.length} questions flagged as possible cross-domain mis-tags:\n`);
  for (const q of qs) {
    console.log(`Q${q.questionNum}  [${q.syllabusTopic}]`);
    console.log(`  id: ${q.id}`);
    const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 300);
    console.log(`  stem: ${stem}${stem.length === 300 ? "…" : ""}`);
    const opts = q.transcribedOptions as string[] | null;
    if (Array.isArray(opts)) {
      opts.forEach((o, i) => console.log(`    (${i + 1}) ${o}`));
    }
    console.log(`  answer: ${q.answer}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
