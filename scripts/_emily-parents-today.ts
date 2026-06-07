// All papers created today (UTC), filtered to those where Emily's
// parents are listed as creator OR Emily is the assignee.

import { prisma } from "../src/lib/db";

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const emily = await prisma.user.findFirst({
    where: { name: { contains: "emily lim", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, studentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } } },
  });
  if (!emily) return;
  const parentIds = emily.studentLinks.map(l => l.parent.id);
  console.log("Emily's parents:");
  for (const p of emily.studentLinks) console.log(`  ${p.parent.id}  ${p.parent.name}  <${p.parent.email}>`);
  console.log();

  // Anything either parent created OR anything assigned to Emily
  const papers = await prisma.examPaper.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { userId: { in: parentIds } },
        { assignedToId: emily.id },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, title: true, paperType: true, subject: true, level: true,
      createdAt: true, completedAt: true,
      user: { select: { name: true } },
      assignedTo: { select: { name: true } },
    },
  });
  console.log(`${papers.length} papers in last 24h by Emily's parents OR assigned to Emily:\n`);
  for (const p of papers) {
    const t = p.createdAt.toISOString().slice(5, 16).replace("T", " ");
    const pType = String(p.paperType ?? "(none)");
    const student = p.assignedTo?.name ?? "(unassigned)";
    console.log(`${t}  [${pType.padEnd(8)}]  ${p.title.slice(0, 55).padEnd(55)} → ${student.padEnd(12)} by ${p.user?.name ?? "?"}`);
  }

  // Also any FeedbackSummary or other related records that might survive a paper delete?
  // Check for orphaned activity logs.
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
