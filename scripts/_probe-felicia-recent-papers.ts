import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const kidIds = ["cmq4xj0vm0029apq234jrmrh6", "cmqj81mfb004m6rbdsgw8zobn"];
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: kidIds },
      NOT: { paperType: { in: ["eval", "quiz", "focused"] } },
      createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
    },
    select: { id: true, title: true, subject: true, level: true, markingStatus: true, paperType: true, createdAt: true, _count: { select: { questions: true } }, assignedToId: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Non-eval, non-quiz, non-focused papers assigned to Caleb/Faith in last 30 days: ${papers.length}`);
  for (const p of papers) {
    const kid = p.assignedToId === kidIds[0] ? "Caleb" : "Faith";
    console.log(`  ${p.createdAt.toISOString().slice(0, 10)}  ${p.markingStatus.padEnd(11)}  ${(p.paperType ?? "master").padEnd(8)}  ${kid.padEnd(6)}  qs=${p._count.questions.toString().padStart(3)}  ${p.subject.padEnd(10)}  → ${p.title.slice(0, 70)}`);
  }
  await prisma.$disconnect();
})();
