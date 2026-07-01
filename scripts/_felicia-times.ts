import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const ps = await prisma.examPaper.findMany({
    where: { id: { in: ["cmqxxlr590001kyi8tze0dzes"] } },
    select: { id: true, title: true, createdAt: true },
  });
  const other = await prisma.examPaper.findMany({
    where: {
      assignedToId: "cmq4xj0vm0029apq234jrmrh6",
      title: "PSLE Mathematics 2016",
      createdAt: { gte: new Date("2026-06-28") },
    },
    select: { id: true, title: true, createdAt: true },
  });
  for (const p of [...ps, ...other]) {
    // Convert to SGT
    const sgt = new Date(p.createdAt.getTime() + 8 * 3600_000);
    console.log(`  ${p.createdAt.toISOString()}  →  SGT ${sgt.toISOString().replace("Z", "+08:00").slice(0, 19)}  · ${p.title} · ${p.id}`);
  }
  await prisma.$disconnect();
})();
