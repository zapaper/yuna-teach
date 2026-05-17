import { prisma } from "../src/lib/db";

// Backfill lastLoginAt from observable activity, since many existing
// students/parents have null lastLoginAt because they were active
// before the lastLoginAt write was added (or never re-authenticated).
//
// For each user, the new value = max of:
//   - existing lastLoginAt
//   - latest examPaper.createdAt (papers they uploaded — parents)
//   - latest assignedExamPaper.completedAt (papers they finished — students)
//   - latest assignedExamPaper.createdAt (papers assigned to them — students)

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true, name: true, role: true, lastLoginAt: true,
      examPapers: {
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      assignedExamPapers: {
        select: { createdAt: true, completedAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  let updated = 0;
  let skipped = 0;
  for (const u of users) {
    const candidates: Date[] = [];
    if (u.lastLoginAt) candidates.push(u.lastLoginAt);
    if (u.examPapers[0]?.createdAt) candidates.push(u.examPapers[0].createdAt);
    if (u.assignedExamPapers[0]?.createdAt) candidates.push(u.assignedExamPapers[0].createdAt);
    if (u.assignedExamPapers[0]?.completedAt) candidates.push(u.assignedExamPapers[0].completedAt);
    if (candidates.length === 0) { skipped++; continue; }
    const max = candidates.reduce((a, b) => (a > b ? a : b));
    const cur = u.lastLoginAt?.getTime() ?? 0;
    if (max.getTime() <= cur) { skipped++; continue; }
    await prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: max } });
    console.log(`  ${u.role.padEnd(7)} ${u.name.padEnd(28)} → ${max.toISOString().slice(0, 16)}`);
    updated++;
  }
  console.log(`\n${updated} users updated, ${skipped} unchanged (no activity or already current).`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
