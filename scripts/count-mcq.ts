import { prisma } from "../src/lib/db";

(async () => {
  // Count master Math + Science MCQ questions. "Master" = the
  // original uploaded paper (not a clone, not a quiz/focused). MCQ
  // detected via transcribedOptions array of 4 OR transcribedOptionImages
  // with content OR a numeric 1-4 answer.
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      OR: [
        { subject: { contains: "math", mode: "insensitive" } },
        { subject: { contains: "science", mode: "insensitive" } },
      ],
    },
    select: { id: true, subject: true, _count: { select: { questions: true } } },
  });
  console.log(`Master Math/Science papers: ${masters.length}`);
  console.log(`Total master questions: ${masters.reduce((s, m) => s + m._count.questions, 0)}`);

  // Pull all questions; classify in JS
  let mathTotal = 0, mathMcq = 0, mathMcqAlready = 0;
  let sciTotal = 0, sciMcq = 0, sciMcqAlready = 0;
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
      if (isMath) {
        mathTotal++;
        if (isMcq) { mathMcq++; if (q.elaboration) mathMcqAlready++; }
      } else {
        sciTotal++;
        if (isMcq) { sciMcq++; if (q.elaboration) sciMcqAlready++; }
      }
    }
  }
  console.log(`\nMath:    total=${mathTotal}  MCQ=${mathMcq}  already-elaborated=${mathMcqAlready}  needing elab=${mathMcq - mathMcqAlready}`);
  console.log(`Science: total=${sciTotal}  MCQ=${sciMcq}  already-elaborated=${sciMcqAlready}  needing elab=${sciMcq - sciMcqAlready}`);
  console.log(`\nTOTAL MCQ needing elaboration: ${(mathMcq + sciMcq) - (mathMcqAlready + sciMcqAlready)}`);

  // Also count clone MCQs (math + science) — for context if user
  // wants to elaborate every existing clone instead of pre-caching
  // masters.
  const cloneCount = await prisma.examQuestion.count({
    where: {
      examPaper: {
        sourceExamId: { not: null },
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "science", mode: "insensitive" } },
        ],
      },
      elaboration: null,
    },
  });
  console.log(`\nClone Math/Science questions without elaboration (any type, MCQ + OEQ): ${cloneCount}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
