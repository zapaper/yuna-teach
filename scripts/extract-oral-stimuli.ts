// Extract the SBC stimulus pictures for every ingested year.
//
// Runs autoCropPictures() over each EnglishSupplementaryPaper row that
// has a stored PDF, writes cropped JPGs to
//   ${VOLUME_PATH}/english-supplementary/<year>_oral_day<N>_stimulus.jpg
// Idempotent — overwrites existing files. Serving endpoint at
// /api/admin/english-oral-coach/stimulus/<year>/<day>/image reads
// straight from the same directory.
//
// Usage:
//   npx tsx scripts/extract-oral-stimuli.ts                  # all years
//   npx tsx scripts/extract-oral-stimuli.ts --year 2024      # single year
//   npx tsx scripts/extract-oral-stimuli.ts --skip-existing  # only years missing crops

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { autoCropPictures } from "../src/lib/english-supplementary";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

const yearArgIdx = process.argv.indexOf("--year");
const YEAR_FILTER = yearArgIdx >= 0 ? process.argv[yearArgIdx + 1] : null;
const SKIP_EXISTING = process.argv.includes("--skip-existing");

async function existsBoth(year: string): Promise<boolean> {
  const p1 = path.join(STORAGE_DIR, `${year}_oral_day1_stimulus.jpg`);
  const p2 = path.join(STORAGE_DIR, `${year}_oral_day2_stimulus.jpg`);
  try {
    await fs.access(p1);
    await fs.access(p2);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const where: { pdfPath: { not: null }; year?: string } = { pdfPath: { not: null } };
  if (YEAR_FILTER) where.year = YEAR_FILTER;
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where,
    orderBy: { year: "desc" },
    select: {
      year: true, pdfPath: true,
      paper4Pages: true, situationalWriting: true, continuousPrompts: true,
      oralDays: true,
    },
  });
  console.log(`${rows.length} candidate year(s)${YEAR_FILTER ? ` (--year ${YEAR_FILTER})` : ""} — skip-existing=${SKIP_EXISTING}`);
  console.log();

  let done = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    if (SKIP_EXISTING && await existsBoth(row.year)) {
      console.log(`  ${row.year}  SKIP (both day-1 + day-2 files already exist)`);
      skipped++;
      continue;
    }
    if (!row.pdfPath) {
      console.log(`  ${row.year}  SKIP (no pdfPath on row)`);
      skipped++;
      continue;
    }
    try {
      const pdfBuffer = await fs.readFile(row.pdfPath);
      const structured = {
        situationalWriting: row.situationalWriting as unknown as { picturePageNum?: number | null } | null,
        continuousPrompts: (row.continuousPrompts as unknown as Array<{ optionNum?: number; picturePageNum?: number | null }>) ?? [],
        oralDays: (row.oralDays as unknown as Array<{ day: number; stimulusPicturePageNum?: number | null }>) ?? [],
      };
      // autoCropPictures's typing wants a StructuredExtraction shape;
      // the ingested Json cols are the same shape at runtime, so cast.
      const result = await autoCropPictures(
        pdfBuffer,
        structured as unknown as Parameters<typeof autoCropPictures>[1],
        STORAGE_DIR,
        row.year,
      );
      const oralOnly = result.savedCount; // savedCount includes situational + continuous crops too; that's fine.
      console.log(`  ${row.year}  OK  saved=${oralOnly}  errors=${result.errors.length}${result.errors.length ? " — " + result.errors.join("; ") : ""}`);
      done++;
    } catch (e) {
      console.log(`  ${row.year}  FAIL  ${(e as Error).message.slice(0, 200)}`);
      failed++;
    }
  }
  console.log();
  console.log(`Summary: ${done} ok, ${skipped} skipped, ${failed} failed`);
  console.log(`Output dir: ${STORAGE_DIR}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
