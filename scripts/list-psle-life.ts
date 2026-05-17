import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ps = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      title: { contains: "life", mode: "insensitive" },
    },
    select: { id: true, title: true, subject: true, visible: true, paperType: true, createdAt: true, _count: { select: { questions: true } } },
    orderBy: { createdAt: "desc" },
  });
  console.log(`${ps.length} life-titled master papers:`);
  for (const p of ps) {
    console.log(`  ${p.id}  visible=${p.visible}  type=${p.paperType ?? "—"}  qs=${p._count.questions}  ${p.title}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
