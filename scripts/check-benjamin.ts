import { prisma } from "../src/lib/db";

(async () => {
  const STUDENT_ID = "cmopc9wpb007svj1mp4mgoae2"; // Benjamin Ong
  const s = await prisma.user.findUnique({
    where: { id: STUDENT_ID },
    select: { id: true, name: true, displayName: true, level: true, role: true },
  });
  console.log("Student:", s);

  // All papers assigned to Benjamin
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: STUDENT_ID },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true, title: true, paperType: true, completedAt: true, markingStatus: true,
      createdAt: true, scheduledFor: true, userId: true, metadata: true,
      user: { select: { name: true } },
    },
  });
  console.log(`\n${papers.length} papers assigned to ${s?.name}:`);
  for (const p of papers) {
    const meta = p.metadata as { revisionMode?: string } | null;
    const rev = meta?.revisionMode ? ` rev=${meta.revisionMode}` : "";
    console.log(`  ${p.createdAt.toISOString().slice(0,16)}  ${p.id}  type=${p.paperType ?? "null"}  done=${p.completedAt ? "yes" : "no"}${rev}`);
    console.log(`    "${p.title}"  by="${p.user?.name}"  scheduled=${p.scheduledFor?.toISOString().slice(0,10) ?? "null"}`);
  }

  // Parent links
  const links = await prisma.parentStudent.findMany({
    where: { studentId: STUDENT_ID },
    include: { parent: { select: { name: true } } },
  });
  console.log(`\n${links.length} parent links:`);
  for (const l of links) console.log(`  ${l.parent.name} (${l.parentId})`);
  await prisma.$disconnect();
})();
