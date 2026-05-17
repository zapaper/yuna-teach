// Quick stats: how many questions have been completed (marked) on
// the platform, excluding any work where the assignee is admin.
// "Admin" = name == "admin" OR settings.admin === true (matches
// src/lib/admin.ts).
//
// Run: npx tsx scripts/count-completed-questions.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1. Find admin user ids.
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, settings: true },
  });
  const adminIds = new Set(
    allUsers
      .filter((u) => {
        if ((u.name ?? "").toLowerCase() === "admin") return true;
        const s = u.settings as Record<string, unknown> | null;
        return s?.admin === true;
      })
      .map((u) => u.id),
  );

  // 2. Count completed questions. "Completed" = marksAwarded is
  // non-null on the question (marker ran + scored, incl. 0).
  // Filter is on `assignedToId` (who TOOK the quiz), not `userId`
  // (who CREATED the paper) — so admin-created → student-assigned
  // → student-completed papers are kept.
  const totalAll = await prisma.examQuestion.count({
    where: { marksAwarded: { not: null } },
  });

  const totalNonAdminTaker = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: { assignedToId: { notIn: [...adminIds] } },
    },
  });

  // Diagnostic: how many were admin-created BUT student-taken?
  // This is the segment the user wanted to make sure is included.
  const adminCreatedStudentTaken = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: {
        userId: { in: [...adminIds] },
        assignedToId: { notIn: [...adminIds] },
      },
    },
  });

  // Diagnostic: admin took it themselves (the bucket we EXCLUDE).
  const adminTakenSelf = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: { assignedToId: { in: [...adminIds] } },
    },
  });

  // Bonus: break down by paper type so we know the mix.
  const breakdown = await prisma.examQuestion.groupBy({
    by: ["examPaperId"],
    where: {
      marksAwarded: { not: null },
      examPaper: { assignedToId: { notIn: [...adminIds] } },
    },
    _count: { _all: true },
  });
  const paperIds = breakdown.map((b) => b.examPaperId);
  const papers = await prisma.examPaper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, paperType: true },
  });
  const typeMap = new Map(papers.map((p) => [p.id, p.paperType ?? "scanned"]));
  const byType: Record<string, number> = {};
  for (const b of breakdown) {
    const t = typeMap.get(b.examPaperId) ?? "scanned";
    byType[t] = (byType[t] ?? 0) + b._count._all;
  }

  console.log(`\nAdmin user count: ${adminIds.size}`);
  console.log(`\nCompleted questions (marksAwarded != null):`);
  console.log(`  - Total across platform        : ${totalAll}`);
  console.log(`  - Excluding admin TAKERS (final): ${totalNonAdminTaker}`);
  console.log(`\nBuckets within that:`);
  console.log(`  - Admin took it themselves   : ${adminTakenSelf}   (EXCLUDED)`);
  console.log(`  - Admin-created, student-took: ${adminCreatedStudentTaken}   (INCLUDED)`);
  console.log(`\nBy paper type (taker is non-admin):`);
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${t.padEnd(12)}: ${n}`);
  }
  console.log();
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
