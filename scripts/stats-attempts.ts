// Stats: how many questions students have attempted, and how
// many quizzes / papers they've completed. Run any time to get
// a current snapshot.
//
// Usage:
//   npx tsx scripts/stats-attempts.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── Papers (clones) the students have engaged with ──────────
  // Anything with a completedAt is a paper they finished. Anything
  // with a non-null sourceExamId AND no completedAt is in-flight.
  const completedPapers = await prisma.examPaper.count({
    where: { completedAt: { not: null }, sourceExamId: { not: null } },
  });
  const inFlightPapers = await prisma.examPaper.count({
    where: { completedAt: null, sourceExamId: { not: null }, assignedToId: { not: null } },
  });

  // ── Question-level attempts ────────────────────────────────
  // marksAwarded is non-null only on clones that have been marked
  // (or partially marked). Counts the student's actual question
  // attempts, not master question rows.
  const markedQuestions = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: { sourceExamId: { not: null } },
    },
  });
  const studentSubmittedQuestions = await prisma.examQuestion.count({
    where: {
      studentAnswer: { not: null },
      examPaper: { sourceExamId: { not: null } },
    },
  });

  // ── Breakdown by paperType ─────────────────────────────────
  const breakdown = await prisma.examPaper.groupBy({
    by: ["paperType"],
    where: { completedAt: { not: null }, sourceExamId: { not: null } },
    _count: true,
  });

  // ── Active students (have completed at least one paper) ────
  const distinctStudents = await prisma.examPaper.findMany({
    where: { completedAt: { not: null }, sourceExamId: { not: null } },
    select: { assignedToId: true },
    distinct: ["assignedToId"],
  });
  const activeStudents = distinctStudents.filter((p) => p.assignedToId).length;

  console.log("");
  console.log("=== MarkForYou attempt stats ===");
  console.log("");
  console.log("Papers / quizzes completed:    ", completedPapers);
  console.log("  by paperType:");
  for (const row of breakdown) {
    console.log(`    ${row.paperType ?? "(regular paper)"}: ${row._count}`);
  }
  console.log("In-flight (assigned, not done):", inFlightPapers);
  console.log("");
  console.log("Question attempts (marked):    ", markedQuestions);
  console.log("Question attempts (any answer):", studentSubmittedQuestions);
  console.log("");
  console.log("Active students (≥1 completed):", activeStudents);
  console.log("");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
