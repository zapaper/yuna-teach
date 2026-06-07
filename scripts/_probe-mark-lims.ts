import { prisma } from "../src/lib/db";

async function main() {
  const marks = await prisma.user.findMany({
    where: { name: { contains: "mark", mode: "insensitive" } },
    select: { id: true, name: true, email: true,
      parentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } },
      studentLinks: { select: { student: { select: { id: true, name: true, email: true } } } },
    },
  });
  for (const u of marks) {
    console.log(`\n${u.name} (${u.id}) email=${u.email}`);
    if (u.parentLinks.length > 0) {
      console.log(`  parents:`);
      for (const pl of u.parentLinks) console.log(`    - ${pl.parent.name} (${pl.parent.id}) ${pl.parent.email}`);
    }
    if (u.studentLinks.length > 0) {
      console.log(`  students:`);
      for (const sl of u.studentLinks) console.log(`    - ${sl.student.name} (${sl.student.id}) ${sl.student.email}`);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
