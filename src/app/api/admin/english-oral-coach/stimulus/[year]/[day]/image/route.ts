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
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

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
    const buf = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json(
      { error: `stimulus picture not found — run scripts/extract-oral-stimuli.ts to backfill` },
      { status: 404 },
    );
  }
}
