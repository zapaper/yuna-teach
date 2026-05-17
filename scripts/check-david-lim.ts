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
    select: {
      id: true, name: true, displayName: true, role: true, level: true,
      lastLoginAt: true, createdAt: true,
      assignedExamPapers: {
        select: { title: true, completedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });
  for (const u of matches) {
    console.log(`${u.id}  ${u.name}  display=${u.displayName}  P${u.level}`);
    console.log(`  createdAt:    ${u.createdAt.toISOString()}`);
    console.log(`  lastLoginAt:  ${u.lastLoginAt ? u.lastLoginAt.toISOString() : "(null)"}`);
    console.log(`  recent papers (${u.assignedExamPapers.length}):`);
    for (const p of u.assignedExamPapers) {
      console.log(`    title=${p.title}  created=${p.createdAt.toISOString().slice(0,16)}  completed=${p.completedAt?.toISOString().slice(0,16) ?? "(no)"}`);
    }
    console.log();
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
