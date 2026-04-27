// Comb through every master ExamPaper that has a stored source PDF and
// paint a tight white rectangle over the bottom-right corner of every
// page. CamScanner stamps its watermark there, and parents are about to
// start printing these PDFs at home — we don't want our paying users
// distributing pages with another vendor's branding on them.
//
// The mask region is intentionally narrow:
//   - WIDTH  = 12% of page width  (~85pt on an A4 portrait page)
//   - HEIGHT = 8%  of page height (~67pt on an A4 portrait page)
// CamScanner's text fits comfortably inside that box with margin to
// spare. If you raise these values you risk clipping question content
// on tightly-laid-out scans, so verify any change against a few sample
// pages first.
//
// SAFETY:
//   - Default mode is --dry-run (no writes).
//   - On first write we copy the existing PDF to <path>.pre-camscanner.bak
//     so a failed batch can be reverted with a one-liner.
//   - Skips clones (sourceExamId != null) — those re-use the master path.
//
// Usage:
//   npx tsx scripts/strip-camscanner-watermark.ts --dry-run
//   npx tsx scripts/strip-camscanner-watermark.ts --paper <id>
//   npx tsx scripts/strip-camscanner-watermark.ts            (apply to all)
//   npx tsx scripts/strip-camscanner-watermark.ts --width 0.12 --height 0.07

import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, rgb } from "pdf-lib";
import { prisma } from "@/lib/db";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");

const DEFAULT_WIDTH_PCT = 0.12;
const DEFAULT_HEIGHT_PCT = 0.08;

function parseArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
}

async function processPaper(
  paperId: string,
  title: string,
  pdfPath: string,
  widthPct: number,
  heightPct: number,
  dryRun: boolean,
): Promise<{ ok: boolean; pages: number; before: number; after: number; reason?: string }> {
  const absPath = path.isAbsolute(pdfPath) ? pdfPath : path.join(VOLUME_PATH, pdfPath);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absPath);
  } catch {
    return { ok: false, pages: 0, before: 0, after: 0, reason: `file missing at ${absPath}` };
  }
  let doc;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (err) {
    return { ok: false, pages: 0, before: bytes.length, after: 0, reason: `pdf-lib load failed: ${(err as Error).message}` };
  }
  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const w = width * widthPct;
    const h = height * heightPct;
    page.drawRectangle({
      x: width - w,
      y: 0,
      width: w,
      height: h,
      color: rgb(1, 1, 1),
      opacity: 1,
    });
  }
  const out = await doc.save();
  if (!dryRun) {
    const backup = `${absPath}.pre-camscanner.bak`;
    let backupExists = false;
    try { await fs.access(backup); backupExists = true; } catch { /* missing */ }
    if (!backupExists) await fs.copyFile(absPath, backup);
    await fs.writeFile(absPath, Buffer.from(out));
  }
  return { ok: true, pages: pages.length, before: bytes.length, after: out.length };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const paperIdx = process.argv.indexOf("--paper");
  const onePaperId = paperIdx >= 0 ? process.argv[paperIdx + 1] : null;
  const widthPct = parseArg("--width", DEFAULT_WIDTH_PCT);
  const heightPct = parseArg("--height", DEFAULT_HEIGHT_PCT);

  const where = onePaperId
    ? { id: onePaperId }
    : { pdfPath: { not: null }, sourceExamId: null };

  const papers = await prisma.examPaper.findMany({
    where,
    select: { id: true, title: true, pdfPath: true, sourceExamId: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nMode: ${dryRun ? "DRY-RUN (no writes)" : "WRITE (files will be overwritten; .pre-camscanner.bak created on first write)"}`);
  console.log(`Mask box: ${(widthPct * 100).toFixed(1)}% width × ${(heightPct * 100).toFixed(1)}% height (bottom-right)`);
  console.log(`Papers matched: ${papers.length}\n`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of papers) {
    if (!p.pdfPath) { skipped++; continue; }
    if (p.sourceExamId) { skipped++; continue; } // safety: never touch a clone
    const result = await processPaper(p.id, p.title, p.pdfPath, widthPct, heightPct, dryRun);
    if (result.ok) {
      processed++;
      console.log(`[${dryRun ? "dry" : "ok"}] ${p.id} — "${p.title}" — ${result.pages} pages — ${result.before.toLocaleString()}→${result.after.toLocaleString()} bytes`);
    } else {
      failed++;
      console.warn(`[fail] ${p.id} — "${p.title}" — ${result.reason}`);
    }
  }

  console.log(`\nDone. processed=${processed} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
