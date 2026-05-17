import { prisma } from "../src/lib/db";

(async () => {
  const parents = await prisma.user.findMany({
    where: { role: "PARENT" },
    select: {
      id: true, name: true, displayName: true, email: true,
      _count: { select: { parentLinks: true, examPapers: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  let none = 0, withPapersButNoLinks = 0;
  for (const p of parents) {
    if (p._count.parentLinks === 0) {
      none++;
      if (p._count.examPapers > 0) {
        withPapersButNoLinks++;
        console.log(`NO LINKS but has papers: ${p.name} | display=${p.displayName} | email=${p.email} | papers=${p._count.examPapers} | id=${p.id.slice(0, 10)}`);
      }
    }
  }
  console.log("---");
  console.log(`Total parents: ${parents.length}`);
  console.log(`Parents with ZERO linked students: ${none}`);
  console.log(`  Of those, ${withPapersButNoLinks} have at least 1 paper uploaded`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
