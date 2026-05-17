import { prisma } from "../src/lib/db";

async function main() {
  // Math MCQ on master papers with $ in stem.
  const dollar = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: "$" },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "math", mode: "insensitive" },
      },
    },
    select: { id: true, transcribedStem: true, transcribedOptions: true },
  });
  const mcq = dollar.filter(q => {
    const opts = q.transcribedOptions as unknown;
    return Array.isArray(opts) && opts.filter(o => typeof o === "string").length === 4;
  });
  const withFrac = mcq.filter(q => /\\frac\b/.test(q.transcribedStem ?? ""));
  const withFracEither = mcq.filter(q => {
    const optsStr = JSON.stringify(q.transcribedOptions);
    return /\\frac\b/.test(q.transcribedStem ?? "") || /\\frac\b/.test(optsStr);
  });
  const currencyOnly = mcq.filter(q => {
    const optsStr = JSON.stringify(q.transcribedOptions);
    return !/\\[a-zA-Z]/.test(q.transcribedStem ?? "") && !/\\[a-zA-Z]/.test(optsStr);
  });

  console.log(`Math MCQ on master papers with $ in stem:`);
  console.log(`  Total:                              ${mcq.length}`);
  console.log(`  With \\frac in stem:                ${withFrac.length}  (real LaTeX in stem)`);
  console.log(`  With \\frac in stem OR options:     ${withFracEither.length}  (real LaTeX anywhere)`);
  console.log(`  Currency-only ($ but no \\command): ${currencyOnly.length}  (these were misrendered)`);
  await prisma.$disconnect();
}
main();
