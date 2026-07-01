import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const users = await prisma.user.findMany({ where: { OR: [{ name: { contains: "student666", mode: "insensitive" } }, { displayName: { contains: "student666", mode: "insensitive" } }] }, select: { id: true, name: true, displayName: true, role: true, level: true, studentLinks: { select: { parent: { select: { id: true, name: true } } } } } });
  console.log(JSON.stringify(users, null, 2));
})();
