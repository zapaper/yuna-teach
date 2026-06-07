import { prisma } from "../src/lib/db";

async function main() {
  const row = await prisma.masterClass.findUnique({
    where: { slug: "math-hidden-constant-total" },
    select: { slug: true, keyConceptScripts: true },
  });
  if (!row) {
    console.log("No MasterClass row — no scripts.");
    return;
  }
  const scripts = (row.keyConceptScripts ?? []) as unknown as string[];
  console.log(`${scripts.length} keyConceptScripts:`);
  scripts.forEach((s, i) => {
    console.log(`\n--- Slide ${i} (${(s || "").length} chars) ---`);
    console.log((s || "(empty)").slice(0, 250));
  });
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
