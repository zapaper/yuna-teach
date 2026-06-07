import { prisma } from "../src/lib/db";

async function main() {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const c = await prisma.examPaper.count({ where: { createdAt: { gte: today } } });
  console.log("papers created today (UTC):", c);
  const recent = await prisma.examPaper.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { title: true, createdAt: true, paperType: true, user: { select: { name: true } } },
  });
  for (const p of recent) {
    console.log(p.createdAt.toISOString(), p.paperType.padEnd(8), (p.user?.name ?? "?").padEnd(12), p.title.slice(0, 70));
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
