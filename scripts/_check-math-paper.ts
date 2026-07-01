import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const p = await prisma.examPaper.findUnique({ where: { id: "cmr1lvc99000hzp2nayw9ymkf" }, select: { title: true, assignedToId: true, userId: true } });
  console.log(p);
})();
