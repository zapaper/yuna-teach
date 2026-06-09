// Count Science / Math MCQ questions on MASTER papers that have a
// diagram attached. Drives the cost estimate for the "regenerate
// Science / Math MCQ with diagrams" admin tool.
//
// Master papers only (sourceExamId=null, paperType=null). Clones
// share their elaboration with the master via the canShareMasterElab
// path, so regenerating just the masters covers everything downstream.
//
// MCQ detection mirrors the live `hasOpts` rule:
//   - transcribedOptions has 4 entries, OR
//   - transcribedOptionImages has at least one non-empty entry, OR
//   - transcribedOptionTable has 4 rows
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_count-sci-math-mcq-with-diagram.ts

import { prisma } from "../src/lib/db";

(async () => {
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      OR: [
        { subject: { contains: "science", mode: "insensitive" } },
        { subject: { contains: "math", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, title: true, subject: true,
      questions: {
        where: { diagramImageData: { not: null } },
        select: {
          id: true,
          transcribedOptions: true,
          transcribedOptionImages: true,
          transcribedOptionTable: true,
          elaboration: true,
          answer: true,
        },
      },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasOpts = (q: any): boolean => {
    const opts = q.transcribedOptions;
    const imgs = q.transcribedOptionImages;
    const tbl = q.transcribedOptionTable;
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(imgs) && imgs.some((o: unknown) => !!o)) return true;
    if (tbl && typeof tbl === "object" && Array.isArray(tbl.rows) && tbl.rows.length === 4) return true;
    return false;
  };

  // Letter-set MCQ pattern (the precise target of the new prompt).
  const letterSetRe = /^\s*(?:[A-D](?:\s*,\s*[A-D]){0,3}(?:\s+and\s+[A-D])?(?:\s+only)?|(?:I{1,3}|IV|V)(?:\s*,\s*(?:I{1,3}|IV|V)){0,3}(?:\s+and\s+(?:I{1,3}|IV|V))?(?:\s+only)?)\s*$/i;

  let totalQuestions = 0;
  let mcqWithDiagram = 0;
  let mcqWithDiagramAlreadyElab = 0;
  let letterSetCount = 0;
  let sciCount = 0, mathCount = 0;

  for (const p of masters) {
    const sl = (p.subject ?? "").toLowerCase();
    const isSci = sl.includes("science");
    const isMath = sl.includes("math");
    for (const q of p.questions) {
      totalQuestions++;
      if (!hasOpts(q)) continue;
      mcqWithDiagram++;
      if (q.elaboration) mcqWithDiagramAlreadyElab++;
      if (isSci) sciCount++;
      else if (isMath) mathCount++;
      const opts = q.transcribedOptions as string[] | null;
      if (Array.isArray(opts) && opts.length === 4 && opts.every(o => typeof o === "string" && letterSetRe.test(o))) {
        letterSetCount++;
      }
    }
  }

  console.log(`Master Sci/Math papers scanned: ${masters.length}`);
  console.log(`Questions on those papers WITH a diagram attached: ${totalQuestions}`);
  console.log();
  console.log(`MCQ with diagram (the regen pool):`);
  console.log(`  total:          ${mcqWithDiagram}`);
  console.log(`    Science:      ${sciCount}`);
  console.log(`    Math:         ${mathCount}`);
  console.log(`  already cached: ${mcqWithDiagramAlreadyElab}`);
  console.log(`  letter-set ("A, B and C only" style): ${letterSetCount}`);
  console.log();
  console.log(`Bulk regen would re-call gemini-3.1-pro-preview ${mcqWithDiagram} times.`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
