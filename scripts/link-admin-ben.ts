import { prisma } from "../src/lib/db";

// Link admin (parent) → Ben P6 student. Lists matches first;
// pass --apply to actually create the parent_students row.

const APPLY = process.argv[2] === "--apply";

async function main() {
  const admins = await prisma.user.findMany({
    where: {
      role: "PARENT",
      OR: [
        { name: { equals: "admin", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, email: true, settings: true },
  });
  // Also pick up admins-by-settings
  const allParents = await prisma.user.findMany({
    where: { role: "PARENT" },
    select: { id: true, name: true, displayName: true, email: true, settings: true },
  });
  const settingsAdmins = allParents.filter((u) => {
    const s = u.settings as { admin?: unknown } | null;
    return s?.admin === true;
  });
  const adminCandidates = [...admins, ...settingsAdmins.filter((s) => !admins.some((a) => a.id === s.id))];
  console.log(`Admin candidates (${adminCandidates.length}):`);
  for (const a of adminCandidates) {
    console.log(`  ${a.id}  name="${a.name}"  display="${a.displayName}"  email="${a.email}"`);
  }
  if (adminCandidates.length === 0) {
    console.error("No admin user found");
    process.exit(1);
  }

  const bens = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      level: 6,
      OR: [
        { name: { contains: "ben", mode: "insensitive" } },
        { displayName: { contains: "ben", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, email: true, level: true },
  });
  console.log(`\nP6 "Ben" matches (${bens.length}):`);
  for (const s of bens) {
    console.log(`  ${s.id}  name="${s.name}"  display="${s.displayName}"  email="${s.email}"  level=${s.level}`);
  }
  if (bens.length === 0) {
    console.error('\nNo P6 student matching "ben"');
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to actually create links.`);
    await prisma.$disconnect();
    return;
  }

  // Disambiguate by exact name: literal "admin" user + literal "Ben"
  // student (not Benjamin Ong).
  const admin = adminCandidates.find((a) => (a.name ?? "").toLowerCase() === "admin");
  const ben = bens.find((s) => (s.name ?? "").toLowerCase() === "ben");
  if (!admin) {
    console.error(`\nNo user with literal name="admin" among admin candidates`);
    process.exit(1);
  }
  if (!ben) {
    console.error(`\nNo P6 student with literal name="Ben"`);
    process.exit(1);
  }
  console.log(`\nResolved: admin="${admin.name}" (${admin.id}) → student="${ben.name}" (${ben.id})`);
  const existing = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: admin.id, studentId: ben.id } },
    select: { id: true },
  });
  if (existing) {
    console.log(`\nAlready linked.`);
  } else {
    await prisma.parentStudent.create({ data: { parentId: admin.id, studentId: ben.id } });
    console.log(`\n→ LINKED admin (${admin.name}) to ${ben.name} (${ben.id})`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
