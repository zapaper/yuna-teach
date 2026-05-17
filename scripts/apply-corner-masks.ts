import path from "path";
import { promises as fs } from "fs";
import { prisma } from "../src/lib/db";
import { maskCorners } from "../src/lib/watermark";

// Bulk-apply CamScanner-style corner masks to every page image of every
// MASTER exam paper (sourceExamId IS NULL, paperType IS NULL). Clones
// inherit their page images via the master, so masking the master is
// enough — we skip clones to avoid re-encoding the same JPEG twice.
//
// Per page:
//   • bottom-right white box (CamScanner watermark)
//   • TOP-LEFT white box on page_0 only (scanner-app email / icon stamp)
//
// Files are rewritten in place. The mask is idempotent — a re-run paints
// white over an already-white region with no visible change. Safe to run
// multiple times.
//
// Usage:
//   npx tsx scripts/apply-corner-masks.ts            # all master papers
//   npx tsx scripts/apply-corner-masks.ts --dry      # report only, no writes
//   npx tsx scripts/apply-corner-masks.ts --paper <id>   # single paper

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const paperIdArg = (() => {
    const i = args.indexOf("--paper");
    return i >= 0 ? args[i + 1] : null;
  })();

  const papers = await prisma.examPaper.findMany({
    where: paperIdArg
      ? { id: paperIdArg }
      : { sourceExamId: null, paperType: null },
    select: { id: true, title: true, subject: true, pageCount: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${"=".repeat(70)}`);
  console.log(`Apply corner masks${dryRun ? " (DRY RUN — no writes)" : ""}`);
  console.log(`Papers to process: ${papers.length}${paperIdArg ? "  (single paper)" : "  (all master papers)"}`);
  console.log(`Pages dir: ${PAGES_DIR}`);
  console.log(`${"=".repeat(70)}\n`);

  let papersOk = 0;
  let papersFail = 0;
  let pagesMasked = 0;
  let pagesSkipped = 0;

  for (const [idx, p] of papers.entries()) {
    const dir = path.join(PAGES_DIR, p.id);
    const label = `${String(idx + 1).padStart(3)}/${papers.length}  ${p.id}  "${(p.title ?? "").slice(0, 48)}"`;

    let exists = false;
    try {
      const st = await fs.stat(dir);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      console.log(`  ${label}  — pages dir missing, skip`);
      papersFail++;
      continue;
    }

    let pagesThisPaper = 0;
    let skippedThisPaper = 0;
    for (let i = 0; i < p.pageCount; i++) {
      const file = path.join(dir, `page_${i}.jpg`);
      try {
        const buf = await fs.readFile(file);
        const out = await maskCorners(buf, { bottomRight: true, topLeft: i === 0 });
        if (!dryRun) await fs.writeFile(file, out);
        pagesThisPaper++;
      } catch {
        skippedThisPaper++;
      }
    }
    pagesMasked += pagesThisPaper;
    pagesSkipped += skippedThisPaper;
    papersOk++;
    const tag = dryRun ? "would mask" : "masked";
    console.log(`  ${label}  — ${tag} ${pagesThisPaper}/${p.pageCount} (${skippedThisPaper} skipped)`);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Done. ${papersOk} papers OK, ${papersFail} failed.`);
  console.log(`Pages ${dryRun ? "would mask" : "masked"}: ${pagesMasked} (${pagesSkipped} skipped on disk-missing).`);
  console.log(`${"=".repeat(70)}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
