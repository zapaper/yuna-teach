import { prisma } from "../src/lib/db";

const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";

(async () => {
  const links = await prisma.parentStudent.findMany({
    where: { parentId: ADMIN_ID },
    include: { student: { select: { id: true, name: true, displayName: true, level: true, createdAt: true } } },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Admin (${ADMIN_ID}) is linked to ${links.length} students:`);
  for (const l of links) {
    console.log(`  ${l.createdAt.toISOString()}  student=${l.student.id}  name="${l.student.name}"  display="${l.student.displayName}"  level=${l.student.level}`);
  }
  // Also look up EBSR2015 directly
  const ebsr = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "EBSR", mode: "insensitive" } },
        { name: { contains: "ebsr2015", mode: "insensitive" } },
        { displayName: { contains: "EBSR", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, role: true, createdAt: true },
  });
  console.log(`\nEBSR matches: ${ebsr.length}`);
  for (const u of ebsr) console.log(`  ${u.id}  ${u.role}  name="${u.name}"  display="${u.displayName}"  created=${u.createdAt.toISOString()}`);
  await prisma.$disconnect();
})();
