import { prisma } from "../src/lib/db";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: "cmpf7ky410001m3283f51y6bn" },
    select: { id: true, title: true, paperType: true, subject: true, sourceExamId: true },
  });
  console.log("MASTER PAPER:", JSON.stringify(p, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
