import { prisma } from "../src/lib/db";
(async () => {
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "benjamin", mode: "insensitive" } },
        { displayName: { contains: "benjamin", mode: "insensitive" } },
        { name: { contains: "ben", mode: "insensitive" } },
      ],
      role: "STUDENT",
    },
    select: { id: true, name: true, displayName: true, email: true, level: true, password: true, createdAt: true, lastLoginAt: true },
  });
  for (const u of matches) {
    const links = await prisma.parentStudent.findMany({ where: { studentId: u.id }, include: { parent: { select: { name: true } } } });
    const assigned = await prisma.examPaper.count({ where: { assignedToId: u.id } });
    const undone = await prisma.examPaper.count({ where: { assignedToId: u.id, completedAt: null } });
    console.log(`\n${u.id}  name="${u.name}"  display="${u.displayName}"  email=${u.email}  level=${u.level}`);
    console.log(`  password: ${u.password ? "SET" : "NULL"}  created=${u.createdAt.toISOString().slice(0,10)}  lastLogin=${u.lastLoginAt?.toISOString().slice(0,10) ?? "never"}`);
    console.log(`  parentLinks: ${links.map(l => l.parent.name).join(", ")}`);
    console.log(`  papers: ${assigned} total / ${undone} undone`);
  }
  await prisma.$disconnect();
})();
