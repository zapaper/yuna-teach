import { prisma } from "../src/lib/db";
async function main() {
  const row = await prisma.masterClass.findUnique({
    where: { slug: "interactions-environment" },
    select: { keyConceptScripts: true },
  });
  const scripts = (row?.keyConceptScripts ?? []) as unknown as string[];
  console.log(`${scripts.length} saved scripts`);
  scripts.forEach((s, i) => console.log(`  slide ${i}: ${(s ?? "").length} chars · ${(s ?? "").slice(0, 80)}…`));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
