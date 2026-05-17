import { prisma } from "../src/lib/db";

// Backfill parent_students rows for any (parent, student) pair where
// the parent uploaded an exam paper and assigned it to that student
// but never created the link explicitly. Idempotent — upsert.
//
// Skip the admin account: admin assigns papers across many students
// for testing and shouldn't auto-grow link rows for all of them.

async function main() {
  const admins = await prisma.user.findMany({
    where: {
      OR: [
        { name: { equals: "admin", mode: "insensitive" } },
        // Anyone marked admin via settings.
      ],
    },
    select: { id: true, settings: true },
  });
  const adminIds = new Set(admins.filter(a => {
    if (a.settings && typeof a.settings === "object" && (a.settings as { admin?: unknown }).admin === true) return true;
    return true;
  }).map(a => a.id));
  // The above is overly broad — just exclude name=admin.
  const adminOnly = new Set(admins.filter(a => true).map(a => a.id));
  console.log(`Excluding admin accounts: ${[...adminOnly].join(", ")}`);

  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { not: null },
      assignedTo: { is: { role: "STUDENT" } },
    },
    select: { userId: true, assignedToId: true, assignedTo: { select: { role: true } } },
  });

  const pairs = new Map<string, { parentId: string; studentId: string }>();
  for (const p of papers) {
    if (!p.userId || !p.assignedToId) continue;
    if (p.userId === p.assignedToId) continue; // self
    if (adminOnly.has(p.userId)) continue;
    const key = `${p.userId}::${p.assignedToId}`;
    if (!pairs.has(key)) pairs.set(key, { parentId: p.userId, studentId: p.assignedToId });
  }
  console.log(`Found ${pairs.size} distinct (parent, student) pairs from assigned papers (admin excluded).`);

  let created = 0;
  let existed = 0;
  for (const { parentId, studentId } of pairs.values()) {
    // Make sure both sides exist and parent is a PARENT.
    const parent = await prisma.user.findUnique({ where: { id: parentId }, select: { role: true, name: true } });
    if (parent?.role !== "PARENT") continue;
    const before = await prisma.parentStudent.findUnique({ where: { parentId_studentId: { parentId, studentId } }, select: { id: true } });
    if (before) { existed++; continue; }
    await prisma.parentStudent.create({ data: { parentId, studentId } });
    console.log(`  + linked ${parent.name} → student ${studentId.slice(0, 10)}`);
    created++;
  }
  console.log(`\nDone. ${created} new links created, ${existed} already existed.`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
