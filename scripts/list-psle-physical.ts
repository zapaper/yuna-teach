import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ps = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      OR: [
        { title: { contains: "physical", mode: "insensitive" } },
        { title: { contains: "PSLE", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, subject: true, visible: true, paperType: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`${ps.length} PSLE/physical-related master papers:`);
  for (const p of ps) {
    console.log(`  ${p.id}  visible=${p.visible}  type=${p.paperType ?? "—"}  ${p.title}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
