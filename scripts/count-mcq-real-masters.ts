import { prisma } from "../src/lib/db";

(async () => {
  // Real master exam papers only: paperType is null (uploaded
  // exams), no sourceExamId. Excludes test quizzes, focused
  // tests, daily quizzes — all of which set paperType to a
  // non-null value.
  for (const tag of ["P4-P5", "All levels"] as const) {
    const levelFilter = tag === "P4-P5" ? {
      AND: [{
        OR: [
          { level: { contains: "Primary 4", mode: "insensitive" as const } },
          { level: { contains: "Primary 5", mode: "insensitive" as const } },
          { level: { equals: "P4", mode: "insensitive" as const } },
          { level: { equals: "P5", mode: "insensitive" as const } },
        ],
      }],
    } : {};
    const masters = await prisma.examPaper.findMany({
      where: {
        sourceExamId: null,
        paperType: null, // ← real uploaded exam papers, not test quizzes / focused / daily quizzes
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "science", mode: "insensitive" } },
        ],
        ...levelFilter,
      },
      select: { id: true, title: true, subject: true, level: true, _count: { select: { questions: true } } },
    });
    console.log(`\n=== ${tag} ===`);
    console.log(`Real master exam papers: ${masters.length}  total questions: ${masters.reduce((s,m)=>s+m._count.questions,0)}`);

    let mathMcq = 0, mathPending = 0, sciMcq = 0, sciPending = 0;
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
        if (isMath) { mathMcq++; if (!q.elaboration) mathPending++; }
        else        { sciMcq++; if (!q.elaboration) sciPending++; }
      }
    }
    console.log(`Math MCQ:    ${mathMcq}  needing elab=${mathPending}`);
    console.log(`Science MCQ: ${sciMcq}  needing elab=${sciPending}`);
    console.log(`TOTAL MCQ needing elab: ${mathPending + sciPending}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
