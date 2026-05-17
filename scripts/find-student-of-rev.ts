import { prisma } from "../src/lib/db";
(async () => {
  const REV = process.argv[2];
  if (!REV) { console.error("usage: <revId>"); process.exit(1); }
  const p = await prisma.examPaper.findUnique({
    where: { id: REV },
    select: { assignedToId: true, assignedTo: { select: { name: true, level: true } } },
  });
  console.log(p?.assignedToId, p?.assignedTo?.name, "P" + p?.assignedTo?.level);
  await prisma.$disconnect();
})();
