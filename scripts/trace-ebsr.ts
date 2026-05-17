import { prisma } from "../src/lib/db";

const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";
const EBSR_ID = "cmonttxlx00678eodvb3mhovt";

(async () => {
  // Any examPaper admin uploaded and assigned to EBSR — most likely
  // route by which a link could appear (the backfill script
  // explicitly skips admin, but a manual assign could create one).
  const papers = await prisma.examPaper.findMany({
    where: { userId: ADMIN_ID, assignedToId: EBSR_ID },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, title: true, createdAt: true, paperType: true, completedAt: true },
  });
  console.log(`Papers admin assigned to EBSR2015: ${papers.length}`);
  for (const p of papers) {
    console.log(`  ${p.createdAt.toISOString()}  ${p.id}  type=${p.paperType}  done=${p.completedAt?.toISOString().slice(0,16) ?? "no"}  "${p.title}"`);
  }
  // The link itself
  const link = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: ADMIN_ID, studentId: EBSR_ID } },
  });
  console.log(`\nLink row:`, link);
  await prisma.$disconnect();
})();
