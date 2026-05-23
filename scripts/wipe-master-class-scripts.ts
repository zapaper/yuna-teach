// One-shot: wipe DB-saved scripts for the 4 MCQ master classes so the
// YAML (now carrying {…} filler braces) becomes the source of truth
// again. Admin panel re-seeds from YAML on next load.

import { prisma } from "../src/lib/db";

const SLUGS = ["grammar-mcq-1", "grammar-mcq-2", "chinese-mcq-1", "chinese-oeq-setpieces", "chinese-idioms", "chinese-sentence-completion"];

(async () => {
  for (const slug of SLUGS) {
    const before = await prisma.masterClass.findUnique({ where: { slug } });
    if (!before) {
      console.log(`  ${slug}: no DB row`);
      continue;
    }
    const keyN = Array.isArray(before.keyConceptScripts) ? (before.keyConceptScripts as string[]).length : 0;
    const mistakeN = Array.isArray(before.commonMistakeScripts) ? (before.commonMistakeScripts as string[]).length : 0;
    await prisma.masterClass.update({
      where: { slug },
      data: { keyConceptScripts: [], commonMistakeScripts: [] },
    });
    console.log(`  ${slug}: cleared (${keyN} key + ${mistakeN} mistake scripts)`);
  }
  await prisma.$disconnect();
})();
