import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, rgb } from "pdf-lib";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// One-shot admin endpoint that paints a 12%×8% white rectangle over the
// bottom-right corner of every page of every master ExamPaper PDF, to
// strip CamScanner-style watermarks before parents print at home.
//
// Defaults to dry-run. Pass ?write=1 to actually overwrite. Originals
// are backed up to <path>.pre-camscanner.bak on first write.
//
// Optional ?paper=<id> processes one paper for testing.
// Optional ?width=0.12&height=0.08 to override mask dimensions.
//
// POST so a stray browser GET can't accidentally trigger writes.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const DEFAULT_WIDTH_PCT = 0.12;
const DEFAULT_HEIGHT_PCT = 0.08;

function pctParam(req: NextRequest, name: string, fallback: number): number {
  const raw = req.nextUrl.searchParams.get(name);
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
}

export async function POST(request: NextRequest) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: sessionUserId }, select: { name: true } });
  if (me?.name?.toLowerCase() !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const write = request.nextUrl.searchParams.get("write") === "1";
  const onePaperId = request.nextUrl.searchParams.get("paper");
  const widthPct = pctParam(request, "width", DEFAULT_WIDTH_PCT);
  const heightPct = pctParam(request, "height", DEFAULT_HEIGHT_PCT);

  const where = onePaperId
    ? { id: onePaperId }
    : { pdfPath: { not: null }, sourceExamId: null };
  const papers = await prisma.examPaper.findMany({
    where,
    select: { id: true, title: true, pdfPath: true, sourceExamId: true },
    orderBy: { createdAt: "asc" },
  });

  type Row = { id: string; title: string; pages?: number; before?: number; after?: number; ok: boolean; reason?: string };
  const results: Row[] = [];
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const p of papers) {
    if (!p.pdfPath) { skipped++; continue; }
    if (p.sourceExamId) { skipped++; continue; }
    const absPath = path.isAbsolute(p.pdfPath) ? p.pdfPath : path.join(VOLUME_PATH, p.pdfPath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absPath);
    } catch {
      results.push({ id: p.id, title: p.title, ok: false, reason: `file missing: ${absPath}` });
      failed++;
      continue;
    }
    let doc;
    try {
      doc = await PDFDocument.load(bytes);
    } catch (err) {
      results.push({ id: p.id, title: p.title, ok: false, reason: `pdf load: ${(err as Error).message}` });
      failed++;
      continue;
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
    if (write) {
      try {
        const backup = `${absPath}.pre-camscanner.bak`;
        let backupExists = false;
        try { await fs.access(backup); backupExists = true; } catch { /* missing */ }
        if (!backupExists) await fs.copyFile(absPath, backup);
        await fs.writeFile(absPath, Buffer.from(out));
      } catch (err) {
        results.push({ id: p.id, title: p.title, ok: false, reason: `write failed: ${(err as Error).message}` });
        failed++;
        continue;
      }
    }
    results.push({ id: p.id, title: p.title, pages: pages.length, before: bytes.length, after: out.length, ok: true });
    processed++;
  }

  return NextResponse.json({
    mode: write ? "WRITE" : "DRY-RUN",
    maskBox: { widthPct, heightPct },
    counts: { matched: papers.length, processed, skipped, failed },
    results,
  });
}
