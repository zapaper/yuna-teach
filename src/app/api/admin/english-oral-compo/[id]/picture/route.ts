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
    select: { id: true, year: true, pdfPath: true,
      situationalWriting: true, continuousPrompts: true, oralDays: true },
  });
}

function pageForKind(
  row: { situationalWriting: unknown; continuousPrompts: unknown; oralDays: unknown },
  kind: string | null,
): { pageNum: number | null; rotate: number } {
  if (!kind) return { pageNum: null, rotate: 0 };
  if (kind === "situational" || kind === "situational_picture") {
    const sw = row.situationalWriting as { picturePageNum?: number } | null;
    return { pageNum: sw?.picturePageNum ?? null, rotate: 0 };
  }
  const cont = kind.match(/^continuous[-_](\d+)$/);
  if (cont) {
    const n = parseInt(cont[1], 10);
    const prompts = row.continuousPrompts as Array<{ optionNum: number; picturePageNum: number | null }> | null;
    return { pageNum: prompts?.find(p => p.optionNum === n)?.picturePageNum ?? null, rotate: 0 };
  }
  const oral = kind.match(/^oral[-_]day(\d+)[-_]stimulus$/);
  if (oral) {
    const d = parseInt(oral[1], 10);
    const days = row.oralDays as Array<{ day: number; stimulusPicturePageNum: number | null }> | null;
    return { pageNum: days?.find(x => x.day === d)?.stimulusPicturePageNum ?? null, rotate: 90 };
  }
  // Listening MCQ crops — pageNum not tracked per-Q in the schema
  // (crops are saved by Gemini's per-page question detection step).
  // The page-render fallback isn't useful for these; only the saved
  // crop is served.
  return { pageNum: null, rotate: 0 };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const kind = request.nextUrl.searchParams.get("kind");
  const type = request.nextUrl.searchParams.get("type");

  if (type === "page") {
    // Explicit ?page=N override — used by the manual cropper when
    // the structured field's picturePageNum is missing or wrong and
    // the admin wants to view a specific page to drag-crop from.
    const explicitPage = parseInt(request.nextUrl.searchParams.get("page") ?? "", 10);
    let pageNum: number | null = Number.isFinite(explicitPage) && explicitPage > 0 ? explicitPage : null;
    if (!pageNum) {
      pageNum = pageForKind(row, kind).pageNum;
    }
    if (!pageNum) return NextResponse.json({ error: "No picture page detected for this kind (pass ?page=N to override)" }, { status: 404 });
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
  const { pageNum, rotate } = pageForKind(row, kind);
  if (!pageNum) return NextResponse.json({ error: "No picture page detected for this kind" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const pageJpeg = await renderSinglePage(pdfBuffer, pageNum, 2400, 90);
    const cropped = await cropPageImage(pageJpeg, { left, top, width, height }, 90, rotate);
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    const out = croppedPath(row.year, kind);
    await fs.writeFile(out, cropped);
    return NextResponse.json({ ok: true, path: out, size: cropped.length });
  } catch (err) {
    return NextResponse.json({ error: "Crop failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
