// Look up py.chua@hotmail.com + their linked children so we know
// what a progress report for them would cover before we build it.

import { prisma } from "../src/lib/db";

(async () => {
  const parent = await prisma.user.findUnique({
    where: { email: "py.chua@hotmail.com" },
    select: { id: true, name: true, role: true, email: true, createdAt: true },
  });
  if (!parent) {
    console.log("No user with email py.chua@hotmail.com");
    // Wider search in case it's a slightly different email or name.
    const wide = await prisma.user.findMany({
      where: { OR: [
        { email: { contains: "py.chua", mode: "insensitive" } },
        { name: { contains: "chua", mode: "insensitive" } },
      ]},
      select: { id: true, name: true, email: true, role: true },
      take: 10,
    });
    console.log(`Wider match (${wide.length}):`);
    for (const u of wide) console.log(`  ${u.name} <${u.email ?? "?"}> ${u.role} ${u.id}`);
    await prisma.$disconnect();
    return;
  }
  console.log(`Parent: ${parent.name} <${parent.email}> ${parent.role}  id=${parent.id}`);

  const links = await prisma.parentStudent.findMany({
    where: { parentId: parent.id },
    select: { student: { select: { id: true, name: true, level: true } } },
  });
  console.log(`\nLinked students (${links.length}):`);
  for (const l of links) console.log(`  ${l.student.name} (P${l.student.level ?? "?"}) ${l.student.id}`);

  // Marked question count per student, for sizing the report.
  for (const l of links) {
    const cnt = await prisma.examQuestion.count({
      where: {
        marksAwarded: { not: null },
        marksAvailable: { not: null },
        examPaper: {
          assignedToId: l.student.id,
          markingStatus: { in: ["complete", "released"] },
        },
      },
    });
    console.log(`    ${l.student.name}: ${cnt} marked questions`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
