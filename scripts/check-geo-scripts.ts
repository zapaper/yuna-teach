import { prisma } from "../src/lib/db";
async function main() {
  const row = await prisma.masterClass.findUnique({ where: { slug: "math-geometry-angles" }, select: { keyConceptScripts: true } });
  const s = (row?.keyConceptScripts ?? []) as unknown as string[];
  console.log(`math-geometry-angles: ${s.length} saved scripts`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
