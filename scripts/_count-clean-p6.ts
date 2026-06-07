// Count "clean" questions per subject for P6 — clean = has a
// transcribedStem populated (the clean-extract step has run).

import { prisma } from "../src/lib/db";

async function main() {
  // Match the level filter the dashboard uses — P6 includes "Primary 6"
  // and "PSLE" labels too, since PSLE papers are functionally P6.
  const levelClause = { level: { in: ["Primary 6", "PSLE", "P6"] as string[] } };

  const subjects = ["Math", "Science", "English", "Chinese"];
  for (const sub of subjects) {
    const totalQs = await prisma.examQuestion.count({
      where: {
        examPaper: {
          ...levelClause,
          subject: { contains: sub, mode: "insensitive" },
          visible: true,
        },
      },
    });
    const cleanQs = await prisma.examQuestion.count({
      where: {
        examPaper: {
          ...levelClause,
          subject: { contains: sub, mode: "insensitive" },
          visible: true,
        },
        transcribedStem: { not: null },
      },
    });
    const papers = await prisma.examPaper.count({
      where: { ...levelClause, subject: { contains: sub, mode: "insensitive" }, visible: true },
    });
    const pct = totalQs > 0 ? ((cleanQs / totalQs) * 100).toFixed(1) : "—";
    console.log(`${sub.padEnd(8)}: ${cleanQs} clean / ${totalQs} total questions (${pct}%) across ${papers} visible papers`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
