// Stats: how many questions students have attempted, and how
// many quizzes / papers they've completed. Run any time to get
// a current snapshot.
//
// Usage:
//   npx tsx scripts/stats-attempts.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── Papers / quizzes the students have engaged with ─────────
  // Filter: assignedToId is non-null. That includes:
  //   - Daily quizzes & focused tests (no sourceExamId, but assigned)
  //   - Clones of regular master papers (sourceExamId set, also assigned)
  // Excludes admin master papers (assignedToId is null on those).
  const completedPapers = await prisma.examPaper.count({
    where: { completedAt: { not: null }, assignedToId: { not: null } },
  });
  const inFlightPapers = await prisma.examPaper.count({
    where: { completedAt: null, assignedToId: { not: null } },
  });

  // ── Question-level attempts ────────────────────────────────
  // marksAwarded is non-null only on rows that have been marked
  // (or partially marked). Filter to questions on student-assigned
  // papers (daily quiz, focused, regular paper clone).
  const markedQuestions = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: { assignedToId: { not: null } },
    },
  });
  const studentSubmittedQuestions = await prisma.examQuestion.count({
    where: {
      studentAnswer: { not: null },
      examPaper: { assignedToId: { not: null } },
    },
  });

  // ── Breakdown by paperType ─────────────────────────────────
  const breakdown = await prisma.examPaper.groupBy({
    by: ["paperType"],
    where: { completedAt: { not: null }, assignedToId: { not: null } },
    _count: true,
  });

  // ── Active students (have completed at least one paper) ────
  const distinctStudents = await prisma.examPaper.findMany({
    where: { completedAt: { not: null }, assignedToId: { not: null } },
    select: { assignedToId: true },
    distinct: ["assignedToId"],
  });
  const activeStudents = distinctStudents.filter((p) => p.assignedToId).length;

  // ── Top students by completed count ────────────────────────
  const perStudent = await prisma.examPaper.groupBy({
    by: ["assignedToId"],
    where: { completedAt: { not: null }, assignedToId: { not: null } },
    _count: true,
    orderBy: { _count: { assignedToId: "desc" } },
    take: 10,
  });
  const studentNames = await prisma.user.findMany({
    where: { id: { in: perStudent.map((s) => s.assignedToId).filter((x): x is string => !!x) } },
    select: { id: true, name: true, displayName: true },
  });
  const nameById = new Map(studentNames.map((s) => [s.id, s.displayName ?? s.name]));

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
  console.log("Top 10 by completed count:");
  for (const row of perStudent) {
    const id = row.assignedToId ?? "?";
    console.log(`  ${(nameById.get(id) ?? id).padEnd(28)} ${row._count}`);
  }
  console.log("");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
