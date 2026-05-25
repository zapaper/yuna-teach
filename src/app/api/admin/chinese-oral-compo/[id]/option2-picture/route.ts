import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { renderSinglePage, cropPageImage } from "@/lib/chinese-supplementary";

// Endpoints for the Paper 1 Option 2 (看图作文) picture.
//
// GET  ?type=page              → serves the full Option 2 page JPEG
//                                (re-rendered on demand from the
//                                stored PDF — we don't keep page
//                                renders on disk to save space).
// GET  (no query)              → serves the cropped picture if one
//                                has been saved, else 404.
// POST { left, top, width, height }   bounds are fractions of the
//                                page image, range 0-1. Crops, saves
//                                to volume, returns { ok, path }.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "chinese-supplementary");

function croppedPath(year: string) {
  return path.join(STORAGE_DIR, `${year}_compo_option2_picture.jpg`);
}

async function loadRow(id: string) {
  return prisma.chineseSupplementaryPaper.findUnique({
    where: { id },
    select: { id: true, year: true, pdfPath: true, compoOption2: true },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const type = request.nextUrl.searchParams.get("type");
  if (type === "page") {
    // Re-render the Option 2 page on demand. picturePageNum lives
    // inside compoOption2 JSON (set during extraction).
    const opt2 = row.compoOption2 as { picturePageNum?: number } | null;
    const pageNum = opt2?.picturePageNum;
    if (!pageNum) return NextResponse.json({ error: "Option 2 picture page not detected" }, { status: 404 });
    if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing on disk" }, { status: 404 });
    try {
      const pdfBuffer = await fs.readFile(row.pdfPath);
      const buf = await renderSinglePage(pdfBuffer, pageNum);
      return new NextResponse(new Uint8Array(buf), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" },
      });
    } catch (err) {
      console.error(`[option2-picture] page render failed for ${row.year}:`, err);
      return NextResponse.json({ error: "Render failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  // Default: serve the already-cropped picture if saved.
  try {
    const buf = await fs.readFile(croppedPath(row.year));
    return new NextResponse(buf, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" },
    });
  } catch {
    return NextResponse.json({ error: "Not cropped yet" }, { status: 404 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json() as { left?: number; top?: number; width?: number; height?: number };
  const { left, top, width, height } = body;
  if (
    typeof left !== "number" || typeof top !== "number" ||
    typeof width !== "number" || typeof height !== "number" ||
    left < 0 || top < 0 || width <= 0 || height <= 0 ||
    left + width > 1.001 || top + height > 1.001
  ) {
    return NextResponse.json({ error: "Invalid bounds — expected fractions 0-1" }, { status: 400 });
  }

  const opt2 = row.compoOption2 as { picturePageNum?: number } | null;
  const pageNum = opt2?.picturePageNum;
  if (!pageNum) return NextResponse.json({ error: "Option 2 picture page not detected" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const pageJpeg = await renderSinglePage(pdfBuffer, pageNum, 2400, 90);  // higher res for the crop source
    const cropped = await cropPageImage(pageJpeg, { left, top, width, height });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    const out = croppedPath(row.year);
    await fs.writeFile(out, cropped);
    return NextResponse.json({ ok: true, path: out, size: cropped.length });
  } catch (err) {
    console.error(`[option2-picture] crop failed for ${row.year}:`, err);
    return NextResponse.json({ error: "Crop failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
