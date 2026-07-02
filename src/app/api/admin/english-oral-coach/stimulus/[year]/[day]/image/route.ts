// GET /api/admin/english-oral-coach/stimulus/<year>/<day>/image
//
// Streams the cropped SBC stimulus picture for a given (year, day).
// Files are produced by autoCropPictures() during PDF ingestion at
// `${VOLUME_PATH}/english-supplementary/<year>_oral_day<N>_stimulus.jpg`
// (see src/lib/english-supplementary.ts and
// scripts/extract-oral-stimuli.ts for the batch backfill runner).

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

// Years that were extracted with the OLD +90° (CW) rotation and are
// now showing sideways. Rotate them on-the-fly by an additional -180°
// no — an additional -90° to reach the correct upright orientation.
// 2025 was extracted correctly with the current pipeline so leave it
// alone.
const YEARS_NEEDING_CCW_FIXUP = new Set([
  "2015", "2016", "2017", "2018", "2019",
  "2020", "2021", "2022", "2023", "2024",
]);

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ year: string; day: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { year, day } = await ctx.params;
  if (!/^\d{4}$/.test(year)) return NextResponse.json({ error: "bad year" }, { status: 400 });
  const dayN = parseInt(day, 10);
  if (dayN !== 1 && dayN !== 2) return NextResponse.json({ error: "day must be 1 or 2" }, { status: 400 });

  const filePath = path.join(STORAGE_DIR, `${year}_oral_day${dayN}_stimulus.jpg`);
  try {
    // Explicit Buffer type: fs.readFile infers Buffer<NonSharedBuffer>
    // and sharp().toBuffer() returns Buffer<ArrayBufferLike>, which
    // TS refuses to unify on the reassignment below.
    let buf: Buffer = await fs.readFile(filePath);
    if (YEARS_NEEDING_CCW_FIXUP.has(year)) {
      // Rotate CCW 90° (sharp uses negative for CCW). This is the
      // on-serve fixup for legacy files extracted with the old
      // +90° CW rotation. Re-running extract-oral-stimuli.ts against
      // the current code will produce upright files and this fixup
      // can then be removed year by year.
      buf = await sharp(buf).rotate(-90).jpeg({ quality: 90 }).toBuffer();
    }
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        // Short cache (5 min) instead of immutable — previous
        // response was pinned with max-age=31536000 immutable and
        // browsers refuse to revalidate that even when the file
        // changes. Query-param cache-buster (?v=2) added on the
        // homepage + SBC page to force a fresh fetch this once.
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: `stimulus picture not found — run scripts/extract-oral-stimuli.ts to backfill` },
      { status: 404 },
    );
  }
}
