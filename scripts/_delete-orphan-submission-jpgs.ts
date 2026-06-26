// Cleans up orphan submission JPG directories on the Railway volume —
// directories under VOLUME_PATH/submissions/<paperId>/ where the
// matching ExamPaper row no longer exists in the DB. Created as a
// follow-up to the 218-row EVAL-clone deletion (b6c6797b), which left
// behind ~218 directories of orphan JPGs on the Railway volume.
//
// MUST RUN ON RAILWAY (not local Windows) — VOLUME_PATH on Railway
// points to /data; locally it points to ./.data which doesn't have
// the prod submission JPGs.
//
// Run via Railway CLI:
//   railway run npx tsx scripts/_delete-orphan-submission-jpgs.ts          (dry run)
//   railway run npx tsx scripts/_delete-orphan-submission-jpgs.ts --apply  (perform delete)
//
// Safety:
//   · Only deletes directories DIRECTLY under VOLUME_PATH/submissions/
//     whose name is a paperId NOT present in ExamPaper. Real papers
//     are never touched.
//   · Dry-run by default — must pass --apply to actually delete.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

const apply = process.argv.includes("--apply");
const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(__dirname, "..", ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

(async () => {
  console.log(`Volume root: ${VOLUME_PATH}`);
  console.log(`Submissions dir: ${SUBMISSIONS_DIR}`);

  let entries: string[] = [];
  try {
    entries = await fs.readdir(SUBMISSIONS_DIR);
  } catch (err) {
    console.error(`Could not read ${SUBMISSIONS_DIR}: ${(err as Error).message}`);
    console.error("Are you running this on Railway? VOLUME_PATH likely needs /data.");
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`Found ${entries.length} entries under submissions/.\n`);

  // Walk every directory and check whether its paperId still exists.
  // We batch the existence checks 100 at a time to keep the round-
  // trip cost down on long dir listings.
  const dirNames: string[] = [];
  for (const name of entries) {
    const full = path.join(SUBMISSIONS_DIR, name);
    try {
      const st = await fs.stat(full);
      if (st.isDirectory()) dirNames.push(name);
    } catch { /* ignore stat errors */ }
  }
  console.log(`${dirNames.length} are directories. Checking against ExamPaper…`);

  const orphans: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < dirNames.length; i += BATCH) {
    const slice = dirNames.slice(i, i + BATCH);
    const found = await prisma.examPaper.findMany({
      where: { id: { in: slice } },
      select: { id: true },
    });
    const foundSet = new Set(found.map(p => p.id));
    for (const name of slice) {
      if (!foundSet.has(name)) orphans.push(name);
    }
  }
  console.log(`Orphan directories (paperId not in DB): ${orphans.length}`);

  if (orphans.length === 0) { await prisma.$disconnect(); return; }
  console.log("\nFirst 20 orphan IDs:");
  for (const id of orphans.slice(0, 20)) console.log(`  ${id}`);
  if (orphans.length > 20) console.log(`  … +${orphans.length - 20} more`);

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to actually delete the directories.");
    await prisma.$disconnect();
    return;
  }

  console.log("\nDeleting orphan directories…");
  let ok = 0, fail = 0;
  for (const name of orphans) {
    const full = path.join(SUBMISSIONS_DIR, name);
    try {
      await fs.rm(full, { recursive: true, force: true });
      ok++;
    } catch (err) {
      console.error(`  FAILED ${name}: ${(err as Error).message}`);
      fail++;
    }
  }
  console.log(`\nDeleted ${ok} directories${fail > 0 ? ` (${fail} failed)` : ""}.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
