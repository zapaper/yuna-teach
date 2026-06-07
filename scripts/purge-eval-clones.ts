// Delete all leftover paperType="eval" clones and their submission
// directories. Eval runs should leave no trace.

import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(__dirname, "..", ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

async function main() {
  const evals = await prisma.examPaper.findMany({
    where: { paperType: "eval" },
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Found ${evals.length} eval clones:`);
  for (const e of evals) console.log(`  ${e.id}  ${e.title}  (${e.createdAt.toISOString()})`);

  if (evals.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // Confirm before deleting — set DELETE=1 to actually do it.
  if (process.env.DELETE !== "1") {
    console.log("\nDRY RUN — re-run with DELETE=1 to actually delete.");
    return;
  }

  for (const e of evals) {
    await prisma.examPaper.delete({ where: { id: e.id } });
    try {
      await fs.rm(path.join(SUBMISSIONS_DIR, e.id), { recursive: true, force: true });
    } catch { /* may not exist locally */ }
    console.log(`  deleted ${e.id}`);
  }
  console.log(`\nDeleted ${evals.length} eval clone(s).`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
