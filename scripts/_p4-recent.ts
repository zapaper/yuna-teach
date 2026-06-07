// Look at every P4 paper created in the last 24 hours — searching by
// level, by title, by emily-lim's parent IDs. The Emily quiz was
// hard-deleted so it won't show, but adjacent activity from her
// parents might reveal who was creating P4 grammar.

import { prisma } from "../src/lib/db";

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Cast a wider net: anything P4 / grammar / english by emily's
  // parents, or any P4 grammar created in last day.
  const parents = ["cmnsa6bww006bgmuwflevt143", "cmm5wfqlf003myrxwj7hrsv7c"]; // peter.lzy, melissawongis (skipping admin)
  // Find Emily's parent IDs dynamically too.
  const emily = await prisma.user.findFirst({
    where: { name: { contains: "emily lim", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, studentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } } },
  });
  const parentIds = (emily?.studentLinks ?? []).map(l => l.parent.id);
  console.log(`Emily's linked parents: ${parentIds.length}`);

  const papers = await prisma.examPaper.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { userId: { in: parentIds } },
        { assignedToId: emily?.id },
        // also any P4 grammar / english quiz today (cross-account)
        { AND: [
          { title: { contains: "P4", mode: "insensitive" } },
          { OR: [
            { title: { contains: "Grammar", mode: "insensitive" } },
            { title: { contains: "English", mode: "insensitive" } },
          ]},
        ]},
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, title: true, paperType: true, subject: true, level: true,
      createdAt: true, completedAt: true, score: true,
      user: { select: { name: true, email: true, role: true } },
      assignedTo: { select: { name: true } },
    },
  });

  console.log(`\n${papers.length} candidates:\n`);
  for (const p of papers) {
    const t = p.createdAt.toISOString().slice(5, 16).replace("T", " ");
    const creator = `${p.user?.name ?? "?"} <${p.user?.email ?? "?"}>`;
    const student = p.assignedTo?.name ?? "(unassigned)";
    const completed = p.completedAt ? "✓" : " ";
    const pType = String(p.paperType ?? "(none)");
    console.log(`${t}  [${pType.padEnd(8)}] ${completed} ${p.title.slice(0, 45).padEnd(45)} → ${student.padEnd(12)} by ${creator}`);
  }
  void parents;
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
