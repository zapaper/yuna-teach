// Rename "Comprehension OE" → "Comprehension OEQ" across existing data.
//
// Why: the structure-analysis step occasionally emits the abbreviated
// name "Comprehension OE" instead of "Comprehension OEQ" / "Comprehension
// Open Ended". The matchers in src/lib/english-sections.ts now accept
// both, so the quiz works regardless — but normalising the stored
// labels keeps future tooling simpler and makes admin views consistent.
//
// Run from yuna-teach/:
//   DRY-RUN (default, no writes):   npx tsx scripts/rename-comprehension-oe.ts
//   APPLY (writes changes):         npx tsx scripts/rename-comprehension-oe.ts --apply
//
// Three places it can appear and what we do:
//
//   1. examQuestion.syllabusTopic = "Comprehension OE"
//      → rewrite to "Comprehension OEQ"
//
//   2. examPaper.metadata.sectionOcrTexts["Comprehension OE"]
//      → rename the JSON key to "Comprehension OEQ" (preserving value)
//
//   3. examPaper.metadata.englishSections[i].label = "Comprehension OE"
//      → rewrite to "Comprehension OEQ"
//
// Idempotent: re-running after --apply is a no-op.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const OLD_NAME = "Comprehension OE";
const NEW_NAME = "Comprehension OEQ";
const APPLY = process.argv.includes("--apply");

function renameKey<T>(obj: Record<string, T>, oldKey: string, newKey: string): Record<string, T> {
  if (!(oldKey in obj) || newKey in obj) return obj;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k === oldKey ? newKey : k] = v;
  return out;
}

async function main() {
  console.log(APPLY ? "APPLYING changes…" : "DRY RUN — no writes. Re-run with --apply to commit.\n");

  // (1) examQuestion.syllabusTopic — bulk count first, then update
  const qCount = await prisma.examQuestion.count({ where: { syllabusTopic: OLD_NAME } });
  console.log(`\n[questions] ${qCount} examQuestion(s) with syllabusTopic = "${OLD_NAME}"`);
  if (APPLY && qCount > 0) {
    const r = await prisma.examQuestion.updateMany({
      where: { syllabusTopic: OLD_NAME },
      data: { syllabusTopic: NEW_NAME },
    });
    console.log(`[questions] updated ${r.count}`);
  }

  // (2) and (3) — scan papers and rewrite metadata JSON
  // Prisma's JSON filter can't easily target nested keys, so fetch all
  // papers' metadata (small column) and filter in JS. Field is small —
  // a few KB per paper, a few thousand papers — well within memory.
  const papers = await prisma.examPaper.findMany({
    where: { metadata: { not: undefined } },
    select: { id: true, title: true, metadata: true },
  });
  console.log(`\n[papers] scanning ${papers.length} paper(s) for metadata mentions…`);

  let metaTouched = 0;
  for (const p of papers) {
    const meta = p.metadata as Record<string, unknown> | null;
    if (!meta) continue;

    let changed = false;
    const newMeta = { ...meta };

    // sectionOcrTexts key rename
    const secOcr = newMeta.sectionOcrTexts as Record<string, unknown> | undefined;
    if (secOcr && OLD_NAME in secOcr) {
      newMeta.sectionOcrTexts = renameKey(secOcr, OLD_NAME, NEW_NAME);
      changed = true;
      console.log(`  - ${p.id} (${p.title}): sectionOcrTexts["${OLD_NAME}"] → "${NEW_NAME}"`);
    }

    // englishSections[i].label rewrite
    const engSecs = newMeta.englishSections as Array<{ label?: string }> | undefined;
    if (Array.isArray(engSecs)) {
      const hits = engSecs.filter(s => s.label === OLD_NAME).length;
      if (hits > 0) {
        newMeta.englishSections = engSecs.map(s => s.label === OLD_NAME ? { ...s, label: NEW_NAME } : s);
        changed = true;
        console.log(`  - ${p.id} (${p.title}): englishSections[${hits}].label "${OLD_NAME}" → "${NEW_NAME}"`);
      }
    }

    if (changed) {
      metaTouched++;
      if (APPLY) {
        await prisma.examPaper.update({
          where: { id: p.id },
          data: { metadata: newMeta as object },
        });
      }
    }
  }

  console.log(`\n[papers] ${metaTouched} paper(s) had metadata mentions`);
  console.log(APPLY ? "\nDone." : "\nDry-run complete. Run with --apply to commit changes.");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
