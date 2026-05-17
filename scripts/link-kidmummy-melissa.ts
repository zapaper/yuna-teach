import { prisma } from "../src/lib/db";

const APPLY = process.argv[2] === "--apply";
const PARENT_ID = "cmop7e59p0000f8epl2htayfu"; // Melissa

async function main() {
  const parent = await prisma.user.findUnique({
    where: { id: PARENT_ID },
    select: { id: true, name: true, role: true },
  });
  if (!parent || parent.role !== "PARENT") {
    console.error("parent not found / not PARENT", parent);
    process.exit(1);
  }
  console.log(`Parent: ${parent.name} (${parent.id})`);

  const matches = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      OR: [
        { name: { contains: "kidmummy", mode: "insensitive" } },
        { displayName: { contains: "kidmummy", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, email: true, level: true },
  });
  console.log(`\n[kidmummy] matches: ${matches.length}`);
  for (const s of matches) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: PARENT_ID, studentId: s.id } },
      select: { id: true },
    });
    console.log(`  ${s.id}  name="${s.name}"  display="${s.displayName}"  email="${s.email}"  level=${s.level}  ${link ? "(already linked)" : "(would link)"}`);
  }
  if (matches.length === 0) { console.error("No match"); process.exit(1); }
  if (matches.length > 1 && APPLY) { console.error("Multiple matches — refusing"); process.exit(1); }

  if (APPLY) {
    const s = matches[0];
    const existing = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: PARENT_ID, studentId: s.id } },
      select: { id: true },
    });
    if (existing) {
      console.log(`Already linked.`);
    } else {
      await prisma.parentStudent.create({ data: { parentId: PARENT_ID, studentId: s.id } });
      console.log(`→ LINKED ${s.name} to ${parent.name}`);
    }
  } else {
    console.log(`\nDry run only. Re-run with --apply to actually link.`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
