import { prisma } from "../src/lib/db";
(async () => {
  const matches = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      OR: [
        { name: { contains: "david", mode: "insensitive" } },
        { displayName: { contains: "david", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, level: true, settings: true, studentLinks: { select: { parent: { select: { name: true, email: true } } } } },
  });
  for (const m of matches) {
    console.log(`${m.id}  name=${m.name}  display=${m.displayName}  P${m.level}`);
    console.log(`  parents: ${m.studentLinks.map(l => `${l.parent.name}<${l.parent.email}>`).join(", ")}`);
    console.log(`  settings: ${JSON.stringify(m.settings)}`);
    console.log();
  }
  await prisma.$disconnect();
})();
