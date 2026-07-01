import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const STU = "cmqg8upha0000l3ijfr3co6t8";
  const links = await prisma.parentStudent.findMany({
    where: { studentId: STU },
    select: { parent: { select: { id: true, name: true, email: true } } },
  });
  console.log(`student67 currently linked to:`);
  for (const l of links) console.log(`  - ${l.parent.name} (${l.parent.id})  ${l.parent.email ?? ""}`);

  // Ensure both admin accounts see student67.
  const wanted = [
    { id: "cmm4tl0f300001ixb254szmg4", label: "Papa/Peter" },
    { id: "cmmfmehcz0000bbbfnwwiko75", label: "admin@yunateach.com" },
  ];
  for (const p of wanted) {
    const exists = await prisma.parentStudent.findUnique({ where: { parentId_studentId: { parentId: p.id, studentId: STU } } });
    if (exists) { console.log(`  ✓ already linked to ${p.label}`); continue; }
    await prisma.parentStudent.create({ data: { parentId: p.id, studentId: STU } });
    console.log(`  + LINKED to ${p.label}`);
  }
  await prisma.$disconnect();
})();
