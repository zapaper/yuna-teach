import { prisma } from "../src/lib/db";

// Diagnostic: for every PARENT, list (a) the students they've linked
// via parent_students, (b) the students who appear on papers they
// uploaded (userId match) or papers assigned to those students.
// Anything in (b) but not in (a) = a missing link the admin page
// can't see.

async function main() {
  const parents = await prisma.user.findMany({
    where: { role: "PARENT" },
    select: {
      id: true, name: true, displayName: true, createdAt: true,
      parentLinks: { select: { studentId: true, student: { select: { id: true, name: true } } } },
      examPapers: {
        where: { assignedToId: { not: null } },
        select: { assignedToId: true, assignedTo: { select: { id: true, name: true, role: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  let mismatched = 0;
  let total = 0;
  for (const p of parents) {
    total++;
    const linked = new Set(p.parentLinks.map(l => l.studentId));
    const onPapers = new Map<string, string>();
    for (const ep of p.examPapers) {
      if (ep.assignedToId && ep.assignedTo?.role === "STUDENT") {
        onPapers.set(ep.assignedToId, ep.assignedTo.name);
      }
    }
    const orphans = [...onPapers.entries()].filter(([id]) => !linked.has(id));
    if (orphans.length > 0) {
      mismatched++;
      console.log(`\nPARENT  ${p.name} (${p.displayName ?? "—"})  id=${p.id}`);
      console.log(`  linked students  (${p.parentLinks.length}):`, p.parentLinks.map(l => l.student.name).join(", ") || "(none)");
      console.log(`  papers assigned to UNLINKED students  (${orphans.length}):`, orphans.map(([id, n]) => `${n}(${id.slice(0,8)})`).join(", "));
    }
  }
  console.log(`\nSummary: ${mismatched} of ${total} parents have papers assigned to students they're not linked to.`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
