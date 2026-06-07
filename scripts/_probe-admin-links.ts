import { prisma } from "../src/lib/db";

async function main() {
  // Find admin user(s), and walk the parent-student table to see who's linked.
  const admins = await prisma.user.findMany({
    where: { name: { equals: "admin", mode: "insensitive" } },
    select: { id: true, name: true, email: true },
  });
  console.log(`Admins (${admins.length}):`);
  for (const a of admins) {
    console.log(`  ${a.name} (${a.id}) email=${a.email}`);
    const links = await prisma.parentStudent.findMany({
      where: { OR: [{ parentId: a.id }, { studentId: a.id }] },
      select: {
        parent: { select: { id: true, name: true } },
        student: { select: { id: true, name: true } },
      },
    });
    for (const l of links) {
      console.log(`    parent=${l.parent.name} (${l.parent.id})  student=${l.student.name} (${l.student.id})`);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
