import { prisma } from "../src/lib/db";
(async () => {
  const byName = await prisma.user.findMany({
    where: { name: { equals: "Melissa", mode: "insensitive" } },
    select: { id: true, name: true, displayName: true, email: true, role: true, createdAt: true },
  });
  const byEmail = await prisma.user.findMany({
    where: { email: { equals: "melissawongis@gmail.com", mode: "insensitive" } },
    select: { id: true, name: true, displayName: true, email: true, role: true, createdAt: true },
  });
  console.log("By name='Melissa':", JSON.stringify(byName, null, 2));
  console.log("By email:", JSON.stringify(byEmail, null, 2));
  await prisma.$disconnect();
})();
