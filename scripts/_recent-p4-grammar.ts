// Look at every P4 Grammar quiz created today across all students —
// the deleted Emily Lim one is gone but pattern of activity may
// reveal who was generating P4 grammar quizzes around that time.

import { prisma } from "../src/lib/db";

async function main() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const papers = await prisma.examPaper.findMany({
    where: {
      createdAt: { gte: todayStart },
      OR: [
        { title: { contains: "Grammar", mode: "insensitive" } },
        { title: { contains: "P4", mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, title: true, paperType: true, subject: true, level: true,
      createdAt: true, completedAt: true, score: true,
      userId: true,
      user: { select: { name: true, email: true, role: true } },
      assignedToId: true,
      assignedTo: { select: { name: true } },
    },
  });

  console.log(`${papers.length} papers created today matching 'Grammar' or 'P4':\n`);
  for (const p of papers) {
    if (!p.title.toLowerCase().includes("p4") && !p.title.toLowerCase().includes("grammar")) continue;
    const t = p.createdAt.toISOString().slice(11, 16);
    const creator = `${p.user?.name ?? "?"} <${p.user?.email ?? p.user?.role ?? "?"}>`;
    const student = p.assignedTo?.name ?? "(unassigned)";
    console.log(`${t}  [${p.paperType.padEnd(8)}]  ${p.title.slice(0, 50).padEnd(50)}  → ${student.padEnd(15)}  by ${creator}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
