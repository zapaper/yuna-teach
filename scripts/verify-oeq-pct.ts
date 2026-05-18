import { prisma } from "../src/lib/db";

// Verify the 91% OEQ claim. Look at all PSLE-and-compilation papers
// in the bank, broken down by paper title, to see if we're excluding
// any MCQ compilation that should count as PSLE content.

const TOPIC = "Interactions within the environment";

(async () => {
  // Get every paper in the bank that mentions PSLE or Life Science.
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "science", mode: "insensitive" },
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { title: { contains: "Life Science", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, level: true },
  });

  console.log("All PSLE-ish papers in the bank:");
  for (const p of papers) {
    const qs = await prisma.examQuestion.count({
      where: { examPaperId: p.id, syllabusTopic: TOPIC, transcribedStem: { not: null } },
    });
    const qsMcq = await prisma.examQuestion.count({
      where: {
        examPaperId: p.id,
        syllabusTopic: TOPIC,
        transcribedStem: { not: null },
        NOT: { transcribedOptions: { equals: null } },
      },
    });
    // Better MCQ count — has a 4-option transcribedOptions
    const allQs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, syllabusTopic: TOPIC, transcribedStem: { not: null } },
      select: { transcribedOptions: true },
    });
    const realMcq = allQs.filter(q => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4).length;
    const realOeq = allQs.length - realMcq;
    console.log(`  ${p.title.padEnd(50)} (${p.level ?? "?"})   total topic Q: ${qs}   MCQ: ${realMcq}   OEQ: ${realOeq}`);
  }

  console.log("\nBroader 'actual-PSLE-content' set (PSLE in title OR P6 Life Science compilation):");
  const broaderRx = /\bPSLE\b|P6 Life Science/i;
  let totalMcq = 0;
  let totalOeq = 0;
  for (const p of papers) {
    if (!broaderRx.test(p.title)) continue;
    const allQs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, syllabusTopic: TOPIC, transcribedStem: { not: null } },
      select: { transcribedOptions: true },
    });
    const m = allQs.filter(q => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4).length;
    const o = allQs.length - m;
    totalMcq += m;
    totalOeq += o;
  }
  const total = totalMcq + totalOeq;
  console.log(`  MCQ: ${totalMcq}  OEQ: ${totalOeq}  Total: ${total}`);
  if (total > 0) {
    console.log(`  MCQ pct: ${((totalMcq / total) * 100).toFixed(0)}%`);
    console.log(`  OEQ pct: ${((totalOeq / total) * 100).toFixed(0)}%`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
