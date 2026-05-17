import { prisma } from "../src/lib/db";

async function main() {
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "jerwin", mode: "insensitive" } },
        { displayName: { contains: "jerwin", mode: "insensitive" } },
        { email: { contains: "jerwin", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, name: true, displayName: true, email: true, role: true, level: true, createdAt: true,
      parentLinks: { select: { student: { select: { id: true, name: true, displayName: true, role: true } } } },
      studentLinks: { select: { parent: { select: { id: true, name: true, displayName: true, role: true } } } },
      _count: { select: { examPapers: true, assignedExamPapers: true, tests: true } },
    },
  });
  console.log(JSON.stringify(matches, null, 2));
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
