// Clear the keyConceptScripts / commonMistakeScripts array on a master
// class row, so the YAML is the source of truth until an admin
// re-saves edits. Run when YAML has been reworked and the DB overlay
// no longer makes sense (renames, reorders, slide adds/removals).

import { prisma } from "../src/lib/db";

async function main() {
  const slug = process.argv[2];
  if (!slug) { console.error("usage: <slug>"); process.exit(1); }
  const row = await prisma.masterClass.findUnique({ where: { slug } });
  if (!row) { console.log(`(no row for ${slug})`); return; }
  const before = {
    key: Array.isArray(row.keyConceptScripts) ? (row.keyConceptScripts as string[]).filter(s => s && s.trim()).length : 0,
    mistake: Array.isArray(row.commonMistakeScripts) ? (row.commonMistakeScripts as string[]).filter(s => s && s.trim()).length : 0,
  };
  await prisma.masterClass.update({
    where: { slug },
    data: { keyConceptScripts: [], commonMistakeScripts: [] },
  });
  console.log(`${slug}: cleared ${before.key} keyConceptScripts + ${before.mistake} commonMistakeScripts → YAML is now source of truth.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
