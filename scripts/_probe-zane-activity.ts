// Check Zane's data footprint — any P2-tagged exam papers, quizzes,
// recommendations, etc. that would be invalidated by flipping to P3?

import { prisma } from "../src/lib/db";

const ZANE_ID = "cmptqgrfe00e7zgzxh7w6x1pz";

async function main() {
  const u = await prisma.user.findUnique({
    where: { id: ZANE_ID },
    select: {
      id: true, name: true, level: true, createdAt: true, lastLoginAt: true,
      settings: true,
    },
  });
  if (!u) { console.log("not found"); return; }
  console.log(`student: ${u.name}  level=${u.level}  created=${u.createdAt.toISOString()}`);
  console.log(`  lastLogin=${u.lastLoginAt?.toISOString() ?? "(never)"}`);

  // Papers assigned to / owned by Zane
  const papers = await prisma.examPaper.count({
    where: { OR: [{ assignedToId: ZANE_ID }, { userId: ZANE_ID }] },
  });
  console.log(`  exam papers (assigned or uploaded): ${papers}`);
  const completed = await prisma.examPaper.count({
    where: { assignedToId: ZANE_ID, completedAt: { not: null } },
  });
  console.log(`  completed papers: ${completed}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
