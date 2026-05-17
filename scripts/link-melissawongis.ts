import { prisma } from "../src/lib/db";

// Link "mark lim", "David lim", "Emily lim" to parent
// melissawongis@gmail.com. Lists matches first; pass --apply
// to actually create the parent_students rows.

const APPLY = process.argv[2] === "--apply";
const PARENT_EMAIL = "melissawongis@gmail.com";
const STUDENT_NAMES = ["mark lim", "david lim", "emily lim"];

async function main() {
  const parent = await prisma.user.findFirst({
    where: { email: { equals: PARENT_EMAIL, mode: "insensitive" } },
    select: { id: true, name: true, displayName: true, email: true, role: true },
  });
  if (!parent) {
    console.error(`No user found with email ${PARENT_EMAIL}`);
    process.exit(1);
  }
  console.log(`Parent: ${parent.id}  ${parent.role}  name="${parent.name}"  display="${parent.displayName}"  email="${parent.email}"`);
  if (parent.role !== "PARENT") {
    console.error("Refusing — target is not a PARENT");
    process.exit(1);
  }

  for (const target of STUDENT_NAMES) {
    const matches = await prisma.user.findMany({
      where: {
        role: "STUDENT",
        OR: [
          { name: { contains: target, mode: "insensitive" } },
          { displayName: { contains: target, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, displayName: true, email: true, level: true },
    });
    console.log(`\n[${target}] ${matches.length} match(es):`);
    for (const s of matches) {
      const existing = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: parent.id, studentId: s.id } },
        select: { id: true },
      });
      console.log(`  ${s.id}  name="${s.name}"  display="${s.displayName}"  email="${s.email}"  level=${s.level}  ${existing ? "(already linked)" : "(would link)"}`);
    }
    if (matches.length === 0) continue;
    if (matches.length > 1 && APPLY) {
      console.error(`  Refusing to apply for "${target}" — multiple matches; resolve ambiguity first`);
      continue;
    }
    if (APPLY) {
      const s = matches[0];
      const existing = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: parent.id, studentId: s.id } },
        select: { id: true },
      });
      if (existing) {
        console.log(`  → already linked, skipping`);
      } else {
        await prisma.parentStudent.create({ data: { parentId: parent.id, studentId: s.id } });
        console.log(`  → LINKED ${s.name} (${s.id}) to parent ${parent.name}`);
      }
    }
  }
  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to actually create links.`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
