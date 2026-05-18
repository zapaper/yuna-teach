import { prisma } from "../src/lib/db";

// "Clean question" = an ExamQuestion that has been clean-extracted
// (transcribedStem populated) AND lives on a TRUE MASTER paper —
//   • sourceExamId IS NULL (not a clone)
//   • paperType IS NULL (regular master, not a quiz/focused/diagnostic
//     template — those re-package master questions for assignment and
//     would double-count the bank)

const MASTER_WHERE = {
  sourceExamId: null,
  paperType: null,
} as const;

(async () => {
  const total = await prisma.examQuestion.count({
    where: {
      transcribedStem: { not: null },
      examPaper: MASTER_WHERE,
    },
  });

  // Break down by subject for context.
  const bySubject = await prisma.examQuestion.groupBy({
    by: ["examPaperId"],
    where: {
      transcribedStem: { not: null },
      examPaper: MASTER_WHERE,
    },
    _count: { id: true },
  });
  const paperIds = bySubject.map((b) => b.examPaperId);
  const papers = await prisma.examPaper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, subject: true, level: true },
  });
  const paperToMeta = new Map(papers.map((p) => [p.id, p]));
  const subjectCounts = new Map<string, number>();
  const subjectByLevel = new Map<string, Map<string, number>>();
  for (const b of bySubject) {
    const p = paperToMeta.get(b.examPaperId);
    const subj = (p?.subject ?? "unknown").toLowerCase();
    const level = p?.level ?? "?";
    subjectCounts.set(subj, (subjectCounts.get(subj) ?? 0) + b._count.id);
    if (!subjectByLevel.has(subj)) subjectByLevel.set(subj, new Map());
    const levels = subjectByLevel.get(subj)!;
    levels.set(level, (levels.get(level) ?? 0) + b._count.id);
  }

  // MCQ vs OEQ split.
  const mcqCount = await prisma.examQuestion.count({
    where: {
      transcribedStem: { not: null },
      examPaper: MASTER_WHERE,
      OR: [
        // Prisma doesn't support JSON array-length filters cleanly, so
        // we widen to "has any non-null option image" or "options json
        // is not null". A second pass tightens via raw row data.
        { transcribedOptions: { not: Prisma.JsonNull } },
        { transcribedOptionImages: { not: Prisma.JsonNull } },
        { transcribedOptionTable: { not: Prisma.JsonNull } },
      ],
    },
  });

  console.log(`${"=".repeat(60)}`);
  console.log(`Clean questions in the bank`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`  Total clean questions:   ${total.toLocaleString()}`);
  console.log(`  ~MCQ (has options json): ${mcqCount.toLocaleString()}`);
  console.log(`  ~OEQ:                    ${(total - mcqCount).toLocaleString()}`);
  console.log();
  console.log(`By subject:`);
  for (const [subj, n] of [...subjectCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${subj}`);
    const levels = subjectByLevel.get(subj);
    if (levels) {
      const rows = [...levels.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1));
      const inline = rows.map(([lvl, c]) => `${lvl}:${c}`).join("  ");
      console.log(`         ${inline}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { Prisma } from "@prisma/client";
