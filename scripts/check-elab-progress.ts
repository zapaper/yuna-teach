import { prisma } from "../src/lib/db";

(async () => {
  // Mirror the bulk-elaborate scope.
  const scope = {
    examPaper: {
      sourceExamId: null,
      paperType: null,
      OR: [
        { subject: { contains: "math", mode: "insensitive" as const } },
        { subject: { contains: "science", mode: "insensitive" as const } },
      ],
      AND: [{
        OR: [
          { level: { contains: "Primary 3", mode: "insensitive" as const } },
          { level: { contains: "Primary 4", mode: "insensitive" as const } },
          { level: { contains: "Primary 5", mode: "insensitive" as const } },
          { level: { contains: "Primary 6", mode: "insensitive" as const } },
          { level: { equals: "P3", mode: "insensitive" as const } },
          { level: { equals: "P4", mode: "insensitive" as const } },
          { level: { equals: "P5", mode: "insensitive" as const } },
          { level: { equals: "P6", mode: "insensitive" as const } },
        ],
      }],
    },
  };
  const all = await prisma.examQuestion.findMany({
    where: scope,
    select: { transcribedOptions: true, transcribedOptionImages: true, answer: true, elaboration: true, updatedAt: true },
  });
  let total = 0, elaborated = 0;
  let recentElaborated: Date | null = null;
  for (const q of all) {
    const opts = q.transcribedOptions as unknown[] | null;
    const optImgs = q.transcribedOptionImages as unknown[] | null;
    const a = (q.answer ?? "").trim().replace(/[().]/g, "");
    const isMcq =
      (Array.isArray(opts) && opts.length === 4) ||
      (Array.isArray(optImgs) && optImgs.some(o => !!o)) ||
      a === "1" || a === "2" || a === "3" || a === "4";
    if (!isMcq) continue;
    total++;
    if (q.elaboration) {
      elaborated++;
      if (!recentElaborated || q.updatedAt > recentElaborated) recentElaborated = q.updatedAt;
    }
  }
  console.log(`Total MCQ in scope: ${total}`);
  console.log(`Elaborated:         ${elaborated}`);
  console.log(`Pending:            ${total - elaborated}`);
  console.log(`Most recent elaboration update: ${recentElaborated?.toISOString() ?? "none"}`);

  // Also show the 5 most-recently elaborated rows so we can see if
  // the loop is actually writing.
  const recent = await prisma.examQuestion.findMany({
    where: { elaboration: { not: null }, examPaper: scope.examPaper },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, questionNum: true, updatedAt: true, examPaper: { select: { title: true } } },
  });
  console.log("\nMost-recently elaborated MCQ rows:");
  for (const r of recent) {
    console.log(`  ${r.updatedAt.toISOString()}  Q${r.questionNum}  "${r.examPaper.title}"`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
