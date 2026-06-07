import { prisma } from "../src/lib/db";

async function main() {
  // Find Emily Lim.
  const emilys = await prisma.user.findMany({
    where: { name: { contains: "emily", mode: "insensitive" }, role: "STUDENT" },
    select: {
      id: true, name: true, level: true, createdAt: true,
      studentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } },
    },
  });
  console.log(`students named Emily*: ${emilys.length}`);
  for (const e of emilys) {
    console.log(`\n${e.id}  ${e.name}  P${e.level}  created=${e.createdAt.toISOString().slice(0, 10)}`);
    for (const link of e.studentLinks) {
      console.log(`  parent: ${link.parent.name} <${link.parent.email}>`);
    }
  }

  // For each Emily, list ALL recent papers (today + last 3 days).
  const since = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  for (const e of emilys) {
    const papers = await prisma.examPaper.findMany({
      where: { assignedToId: e.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, title: true, paperType: true, subject: true, level: true,
        createdAt: true, completedAt: true, score: true, totalMarks: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
    });
    console.log(`\n=== ${e.name} — ${papers.length} papers in last 4 days ===`);
    for (const p of papers) {
      const created = p.createdAt.toISOString().slice(0, 16).replace("T", " ");
      const completed = p.completedAt ? p.completedAt.toISOString().slice(0, 16).replace("T", " ") : "(none)";
      console.log(`  ${created}  [${p.paperType}] ${p.subject ?? "?"} ${p.level ?? "?"}  ${p.title.slice(0, 60)}`);
      console.log(`    id=${p.id}  created-by: ${p.user?.name ?? "?"} <${p.user?.email ?? "?"}>  (userId=${p.userId})`);
      console.log(`    completed=${completed}  score=${p.score}/${p.totalMarks}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
