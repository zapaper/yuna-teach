import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// GET /api/exam/:id/annotations → { annotationsByPage } map.
// After baking, this returns an empty map — the strokes now live inside the
// PDF itself. The client starts each annotate session with a blank canvas
// stacked on top of the already-baked PDF.
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

// PUT /api/exam/:id/annotations — bake the annotation PNGs into the stored
// PDF. Admin-only.
// Body: { annotationsByPage: { "0": dataUrl, "1": dataUrl, ... } }
// Flow:
//   1. Validate the incoming map.
//   2. Load the existing PDF from pdfPath.
//   3. For each page with an annotation, embed the PNG and drawImage it
//      across the full page (pdf-lib origin is bottom-left, but drawImage
//      paints upright).
//   4. Write the modified PDF back to the same path.
//   5. Invalidate the disk-cached page JPGs so re-renders pick up the
//      baked-in annotations.
//   6. Clear the annotationsByPage column — next session starts fresh.
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
  const entries: Array<[number, string]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.startsWith("data:image/")) continue;
    const pageIdx = Number(k);
    if (!Number.isInteger(pageIdx) || pageIdx < 0) continue;
    entries.push([pageIdx, v]);
  }

  if (entries.length === 0) {
    // Nothing to bake — clear any lingering draft state and return.
    await prisma.examPaper.update({
      where: { id },
      data: { annotationsByPage: {} },
    });
    return NextResponse.json({ ok: true, pagesBaked: 0 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { pdfPath: true, pageCount: true },
  });
  if (!paper?.pdfPath) {
    return NextResponse.json({ error: "No source PDF stored for this paper" }, { status: 400 });
  }

  let pdfBytes: Buffer;
  try {
    pdfBytes = await fs.readFile(paper.pdfPath);
  } catch {
    return NextResponse.json({ error: "PDF file missing on disk" }, { status: 404 });
  }

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  let baked = 0;
  for (const [pageIdx, dataUrl] of entries) {
    if (pageIdx >= pages.length) continue; // out-of-range annotation — skip
    // Strip the data URL prefix then decode to raw bytes for embedPng.
    const comma = dataUrl.indexOf(",");
    if (comma < 0) continue;
    const pngBytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
    try {
      const png = await pdfDoc.embedPng(pngBytes);
      const page = pages[pageIdx];
      const { width, height } = page.getSize();
      page.drawImage(png, { x: 0, y: 0, width, height });
      baked++;
    } catch (err) {
      console.error(`[annotations] Failed to embed page ${pageIdx}:`, err);
    }
  }

  const modified = await pdfDoc.save();
  await fs.writeFile(paper.pdfPath, Buffer.from(modified));

  // Invalidate the pre-rendered JPG cache for this paper so the edit/review
  // UIs re-render from the newly-baked PDF on next visit.
  try {
    const pagesDir = path.join(PAGES_DIR, id);
    const files = await fs.readdir(pagesDir);
    await Promise.all(files.map(f => fs.rm(path.join(pagesDir, f)).catch(() => {})));
  } catch { /* no cached pages — fine */ }

  // Clear the draft annotations — strokes now live in the PDF itself.
  await prisma.examPaper.update({
    where: { id },
    data: { annotationsByPage: {} },
  });

  return NextResponse.json({ ok: true, pagesBaked: baked });
}
