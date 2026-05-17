import { prisma } from "../src/lib/db";

(async () => {
  // Master Math/Science MCQ count, restricted to Primary 4 & 5.
  // Level on examPaper is a free-text string; match common variants.
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      OR: [
        { subject: { contains: "math", mode: "insensitive" } },
        { subject: { contains: "science", mode: "insensitive" } },
      ],
      AND: [{
        OR: [
          { level: { contains: "Primary 4", mode: "insensitive" } },
          { level: { contains: "Primary 5", mode: "insensitive" } },
          { level: { equals: "P4", mode: "insensitive" } },
          { level: { equals: "P5", mode: "insensitive" } },
          { level: { equals: "4", mode: "insensitive" } },
          { level: { equals: "5", mode: "insensitive" } },
        ],
      }],
    },
    select: { id: true, subject: true, level: true, _count: { select: { questions: true } } },
  });
  // Tally levels
  const levelCounts = new Map<string, number>();
  for (const m of masters) {
    levelCounts.set(m.level ?? "(null)", (levelCounts.get(m.level ?? "(null)") ?? 0) + 1);
  }
  console.log(`Master Math/Science P4-P5 papers: ${masters.length}`);
  console.log("By level field:");
  for (const [k, v] of levelCounts) console.log(`  "${k}": ${v}`);
  console.log(`Total master questions: ${masters.reduce((s, m) => s + m._count.questions, 0)}`);

  let mathMcq = 0, mathMcqPending = 0;
  let sciMcq = 0, sciMcqPending = 0;
  for (const m of masters) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: m.id },
      select: { transcribedOptions: true, transcribedOptionImages: true, answer: true, elaboration: true },
    });
    const isMath = (m.subject ?? "").toLowerCase().includes("math");
    for (const q of qs) {
      const opts = q.transcribedOptions as unknown[] | null;
      const optImgs = q.transcribedOptionImages as unknown[] | null;
      const a = (q.answer ?? "").trim().replace(/[().]/g, "");
      const isMcq =
        (Array.isArray(opts) && opts.length === 4) ||
        (Array.isArray(optImgs) && optImgs.some(o => !!o)) ||
        a === "1" || a === "2" || a === "3" || a === "4";
      if (!isMcq) continue;
      if (isMath) {
        mathMcq++;
        if (!q.elaboration) mathMcqPending++;
      } else {
        sciMcq++;
        if (!q.elaboration) sciMcqPending++;
      }
    }
  }
  console.log(`\nMath P4-P5:    MCQ=${mathMcq}  needing elab=${mathMcqPending}`);
  console.log(`Science P4-P5: MCQ=${sciMcq}  needing elab=${sciMcqPending}`);
  console.log(`\nTOTAL P4-P5 MCQ needing elaboration: ${mathMcqPending + sciMcqPending}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
