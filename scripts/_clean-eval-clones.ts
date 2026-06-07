import { prisma } from "../src/lib/db";

async function main() {
  const r = await prisma.examPaper.deleteMany({ where: { paperType: "eval" } });
  console.log(`deleted ${r.count} eval papers`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
