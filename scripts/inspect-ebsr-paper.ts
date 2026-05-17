import { prisma } from "../src/lib/db";
(async () => {
  const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";
  const PAPER_ID = "cmopg95bm004w3oupacdj5z4q"; // auto-link trigger
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, sourceExamId: true, paperType: true, userId: true, assignedToId: true, createdAt: true, scheduledFor: true, user: { select: { name: true } } },
  });
  console.log("paper:", p);
  if (p?.sourceExamId) {
    const m = await prisma.examPaper.findUnique({
      where: { id: p.sourceExamId },
      select: { id: true, title: true, userId: true, user: { select: { name: true } } },
    });
    console.log("master:", m);
    console.log(`note: master.userId=${m?.userId} === ADMIN_ID? ${m?.userId === ADMIN_ID}`);
  }
  await prisma.$disconnect();
})();
