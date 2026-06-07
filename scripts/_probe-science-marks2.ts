// Inspect the full structure metadata for the Red Swastika paper to
// understand why Q1-Q12 didn't get the 2-mark default but Q13-Q28 did.

import { prisma } from "../src/lib/db";

const PAPER_ID = "cmptq7cua00bnzgzx1093rbt2";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  const md = (paper?.metadata ?? {}) as Record<string, unknown>;
  // Print full papers array and any sections-like data.
  console.log("=== metadata.papers (full) ===");
  console.log(JSON.stringify(md.papers, null, 2));
  if (md.structure) {
    console.log("\n=== metadata.structure (truncated) ===");
    console.log(JSON.stringify(md.structure, null, 2).slice(0, 4000));
  }
  console.log("\nall metadata keys:");
  for (const k of Object.keys(md)) {
    const v = md[k];
    const s = JSON.stringify(v);
    console.log(`  ${k}: ${s == null ? "null" : (s.length > 120 ? s.slice(0, 120) + "…" : s)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
