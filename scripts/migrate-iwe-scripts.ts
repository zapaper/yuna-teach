// One-off: after inserting a new slide (8 = Fair-test) before the CTA
// in interactions-environment.yaml, shift the saved CTA narration script
// from old index 8 → new index 9. Insert an empty placeholder at index 8
// so the YAML's visible text is used for narration on that slide.
//
// Original saved scripts (indices 0-8):
//   0 Welcome · 1 Definitions · 2 Food Web · 3 Causal Chain ·
//   4 Mutual · 5 Adaptation · 6 Decomposer · 7 Human Impact · 8 CTA
// After this migration (indices 0-9):
//   0-7 unchanged · 8 EMPTY (Fair-test, falls back to YAML) · 9 CTA
import { prisma } from "../src/lib/db";

const apply = process.argv.includes("--apply");

async function main() {
  const row = await prisma.masterClass.findUnique({
    where: { slug: "interactions-environment" },
    select: { keyConceptScripts: true },
  });
  if (!row) { console.log("No row"); return; }
  const before = (row.keyConceptScripts ?? []) as unknown as string[];
  console.log(`Before: ${before.length} entries`);
  before.forEach((s, i) => console.log(`  ${i}: ${(s ?? "").slice(0, 60)}…`));

  if (before.length !== 9) {
    console.log("\nUnexpected: expected 9 entries before migration. Aborting.");
    return;
  }

  const after: string[] = [
    ...before.slice(0, 8), // 0-7 stay
    "",                     // 8: new Fair-test slide — placeholder
    before[8],              // 9: CTA (was 8)
  ];

  console.log(`\nAfter: ${after.length} entries`);
  after.forEach((s, i) => console.log(`  ${i}: ${(s ?? "").slice(0, 60)}…`));

  if (!apply) { console.log("\nDRY RUN. Re-run with --apply to commit."); return; }

  await prisma.masterClass.update({
    where: { slug: "interactions-environment" },
    data: { keyConceptScripts: after as unknown as object },
  });
  console.log("\n✅ Migrated.");
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
