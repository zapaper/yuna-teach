import { prisma } from "../src/lib/db";

// Unlink admin from a list of students. Lists matches first; pass
// --apply to actually delete the parent_students rows.

const APPLY = process.argv[2] === "--apply";
const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75"; // literal name="admin" user
const TARGETS = ["ben", "studentp5"]; // literal-name matches (case-insensitive)

async function main() {
  const admin = await prisma.user.findUnique({
    where: { id: ADMIN_ID },
    select: { name: true, role: true },
  });
  if (!admin || admin.role !== "PARENT") {
    console.error("admin not found or not PARENT", admin);
    process.exit(1);
  }
  console.log(`Admin: ${admin.name} (${ADMIN_ID})`);

  for (const target of TARGETS) {
    const matches = await prisma.user.findMany({
      where: {
        role: "STUDENT",
        OR: [
          { name: { equals: target, mode: "insensitive" } },
          { displayName: { equals: target, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, displayName: true, level: true },
    });
    console.log(`\n[${target}] exact-name matches: ${matches.length}`);
    for (const s of matches) {
      const link = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: ADMIN_ID, studentId: s.id } },
        select: { id: true },
      });
      console.log(`  ${s.id}  name="${s.name}"  display="${s.displayName}"  level=${s.level}  ${link ? "(LINKED — would unlink)" : "(not linked)"}`);
    }
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      console.error(`  Multiple matches for "${target}" — refusing to apply`);
      continue;
    }
    if (APPLY) {
      const s = matches[0];
      const link = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: ADMIN_ID, studentId: s.id } },
        select: { id: true },
      });
      if (!link) {
        console.log(`  → not linked, nothing to do`);
      } else {
        await prisma.parentStudent.delete({
          where: { parentId_studentId: { parentId: ADMIN_ID, studentId: s.id } },
        });
        console.log(`  → UNLINKED admin from ${s.name}`);
      }
    }
  }
  if (!APPLY) console.log(`\nDry run only. Re-run with --apply to actually unlink.`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
