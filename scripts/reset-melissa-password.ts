import { prisma } from "../src/lib/db";
(async () => {
  const u = await prisma.user.update({
    where: { id: "cmop7e59p0000f8epl2htayfu" },
    data: { password: "1234" },
    select: { id: true, name: true, email: true, role: true },
  });
  console.log("Password reset for:", u);
  // List parent-student links so we confirm nothing was lost
  const links = await prisma.parentStudent.findMany({
    where: { parentId: u.id },
    include: { student: { select: { name: true, level: true } } },
  });
  console.log("Linked students:");
  for (const l of links) console.log(`  ${l.student.name} (P${l.student.level})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
