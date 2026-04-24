import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// GET /api/exam/:id/annotations — draft map. Always empty after a bake.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { annotationsByPage: true },
  });
  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ annotationsByPage: paper.annotationsByPage ?? {} });
}

// PUT /api/exam/:id/annotations — bake the annotation PNGs into:
//   (a) the disk JPG cache (so /edit / area-selector show the annotated
//       page), and
//   (b) the stored PDF.
// Does NOT re-crop individual question.imageData rows — admin re-crops
// the 1–2 affected questions manually from the clean editor's area
// selector, which reads from the freshly-overlaid disk JPGs.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const raw = body.annotationsByPage;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "annotationsByPage object required" }, { status: 400 });
  }

  // Decode each "<pageIndex>" → PNG buffer.
  const overlays = new Map<number, Buffer>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.startsWith("data:image/")) continue;
    const pageIdx = Number(k);
    if (!Number.isInteger(pageIdx) || pageIdx < 0) continue;
    const comma = v.indexOf(",");
    if (comma < 0) continue;
    const buf = Buffer.from(v.slice(comma + 1), "base64");
    if (buf.length > 0) overlays.set(pageIdx, buf);
  }

  if (overlays.size === 0) {
    await prisma.examPaper.update({
      where: { id },
      data: { annotationsByPage: {} },
    });
    return NextResponse.json({ ok: true, pagesBaked: 0, pagesOverlaid: 0 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { pdfPath: true },
  });
  if (!paper?.pdfPath) {
    return NextResponse.json({ error: "No source PDF stored for this paper" }, { status: 400 });
  }

  // ─── 1. Composite onto disk JPG cache ───────────────────────────────────
  const pagesDir = path.join(PAGES_DIR, id);
  let overlaid = 0;
  for (const [pageIdx, pngBuf] of overlays.entries()) {
    try {
      const jpgPath = path.join(pagesDir, `page_${pageIdx}.jpg`);
      const jpgBuf = await fs.readFile(jpgPath);
      const meta = await sharp(jpgBuf).metadata();
      if (!meta.width || !meta.height) continue;
      const overlayResized = await sharp(pngBuf)
        .resize({ width: meta.width, height: meta.height, fit: "fill" })
        .png()
        .toBuffer();
      const composited = await sharp(jpgBuf)
        .composite([{ input: overlayResized, top: 0, left: 0 }])
        .jpeg({ quality: 88 })
        .toBuffer();
      await fs.writeFile(jpgPath, composited);
      overlaid++;
    } catch (err) {
      console.warn(`[annotations] composite failed for page ${pageIdx}:`, err);
    }
  }

  // ─── 2. Bake into the PDF ───────────────────────────────────────────────
  let pdfBaked = 0;
  try {
    const pdfBytes = await fs.readFile(paper.pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pdfPages = pdfDoc.getPages();
    for (const [pageIdx, pngBuf] of overlays.entries()) {
      if (pageIdx >= pdfPages.length) continue;
      try {
        const png = await pdfDoc.embedPng(pngBuf);
        const pg = pdfPages[pageIdx];
        const { width, height } = pg.getSize();
        pg.drawImage(png, { x: 0, y: 0, width, height });
        pdfBaked++;
      } catch (err) {
        console.warn(`[annotations] PDF embed failed for page ${pageIdx}:`, err);
      }
    }
    const modified = await pdfDoc.save();
    await fs.writeFile(paper.pdfPath, Buffer.from(modified));
  } catch (err) {
    console.error("[annotations] PDF bake failed:", err);
  }

  await prisma.examPaper.update({
    where: { id },
    data: { annotationsByPage: {} },
  });

  return NextResponse.json({
    ok: true,
    pagesBaked: pdfBaked,
    pagesOverlaid: overlaid,
  });
}
