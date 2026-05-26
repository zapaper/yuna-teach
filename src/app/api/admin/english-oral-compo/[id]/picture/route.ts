import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { renderSinglePage, cropPageImage } from "@/lib/english-supplementary";

// Picture endpoints for English Paper 1 (3 continuous-writing
// prompts) and Paper 4 (1 oral stimulus picture).
//
// GET  ?type=page&kind=continuous-N    serves the Nth continuous prompt page
// GET  ?type=page&kind=oral-stimulus   serves the oral stimulus picture page
// GET  ?kind=continuous-N              serves the saved crop for prompt N
// GET  ?kind=oral-stimulus             serves the saved oral-stimulus crop
// POST { kind, left, top, width, height }   crop fractions 0-1, saves to volume

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

function croppedPath(year: string, kind: string) {
  return path.join(STORAGE_DIR, `${year}_${kind}.jpg`);
}

async function loadRow(id: string) {
  return prisma.englishSupplementaryPaper.findUnique({
    where: { id },
    select: { id: true, year: true, pdfPath: true, continuousPrompts: true, oralStimulusPicture: true },
  });
}

function pageForKind(row: { continuousPrompts: unknown; oralStimulusPicture: unknown }, kind: string | null): number | null {
  if (!kind) return null;
  if (kind === "oral-stimulus") {
    const osp = row.oralStimulusPicture as { picturePageNum?: number } | null;
    return osp?.picturePageNum ?? null;
  }
  const m = kind.match(/^continuous-(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const prompts = row.continuousPrompts as Array<{ optionNum: number; picturePageNum: number | null }> | null;
    const hit = prompts?.find(p => p.optionNum === n);
    return hit?.picturePageNum ?? null;
  }
  return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const kind = request.nextUrl.searchParams.get("kind");
  const type = request.nextUrl.searchParams.get("type");

  if (type === "page") {
    const pageNum = pageForKind(row, kind);
    if (!pageNum) return NextResponse.json({ error: "No picture page detected for this kind" }, { status: 404 });
    if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });
    try {
      const pdfBuffer = await fs.readFile(row.pdfPath);
      const buf = await renderSinglePage(pdfBuffer, pageNum);
      return new NextResponse(new Uint8Array(buf), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" },
      });
    } catch (err) {
      return NextResponse.json({ error: "Render failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });
  try {
    const buf = await fs.readFile(croppedPath(row.year, kind));
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" },
    });
  } catch {
    return NextResponse.json({ error: "Not cropped yet" }, { status: 404 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await request.json() as { kind?: string; left?: number; top?: number; width?: number; height?: number };
  const { kind, left, top, width, height } = body;
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });
  if (typeof left !== "number" || typeof top !== "number" || typeof width !== "number" || typeof height !== "number" ||
      left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 1.001 || top + height > 1.001) {
    return NextResponse.json({ error: "Invalid bounds — fractions 0-1 required" }, { status: 400 });
  }
  const pageNum = pageForKind(row, kind);
  if (!pageNum) return NextResponse.json({ error: "No picture page detected for this kind" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const pageJpeg = await renderSinglePage(pdfBuffer, pageNum, 2400, 90);
    const cropped = await cropPageImage(pageJpeg, { left, top, width, height });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    const out = croppedPath(row.year, kind);
    await fs.writeFile(out, cropped);
    return NextResponse.json({ ok: true, path: out, size: cropped.length });
  } catch (err) {
    return NextResponse.json({ error: "Crop failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
