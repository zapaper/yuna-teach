import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { prisma } from "@/lib/db";
import { requireAccessToStudent } from "@/lib/auth-guard";

// GET /api/exam/[id]/print?studentId=<id>&userId=<parent>
//
// Returns the original master PDF for parents to print at home, with
// a small code stamped on the top-right of page 1. The code encodes
// the paperId + studentId so the inbound-email webhook can match a
// scanned submission back to the paper and assign it to the right
// child. Format: 'MFY-<paper8>-<student8>' — first 8 chars of each
// cuid are unique enough at our scale (collision risk ~1/1B).

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const studentId = request.nextUrl.searchParams.get("studentId");
  // ?inline=1 → render the PDF inline so the client can embed it in
  // a hidden iframe and call iframe.contentWindow.print() to open
  // the system print dialog directly.
  const inline = request.nextUrl.searchParams.get("inline") === "1";

  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }

  // Caller from session; access via the student auth helper.
  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, subject: true, pdfPath: true, metadata: true, sourceExamId: true, paperType: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // English / Chinese quiz + focused practice were previously blocked
  // for everyone (incl. admin) because the lined-A4 printable layout
  // was being rebuilt. That block has been removed — the route now
  // falls back gracefully (Chinese print appends the OEQ pad when
  // present, omits it when not; English clones use the master's
  // original PDF). The English Normal-Extract check further below
  // still gates English non-extracted papers with a clearer message.
  // Parents are gated client-side via subjectBlocksPrintScan, which
  // requires cleanExtracted=true for English/Chinese.

  // Clone fallback: Test Quiz clones (paperType="quiz") inherit
  // metadata from the master but don't carry their own pdfPath.
  // When the print route is asked to serve such a clone — happens
  // for English Test Quizzes routed here so the scan-back marker
  // can use the master's PDF layout + the clone's normal-extract
  // bounds — fall back to the source paper's PDF.
  let pdfPath = paper.pdfPath;
  let metaForDrop = paper.metadata;
  let sourceMeta: { normalExtractEnglish?: Record<string, unknown>; normalExtractChinese?: Record<string, unknown> } | null = null;
  // The "owner" id whose /pages/<id>/page_N.jpg files we'll fall back
  // to if no PDF exists on disk. Defaults to this paper, but if it's
  // a clone (or its source master has the JPEGs), we'll prefer that.
  let pageImagesOwnerId = id;
  if (!pdfPath && paper.sourceExamId) {
    const source = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { id: true, pdfPath: true, metadata: true, pageCount: true },
    });
    if (source?.pdfPath) {
      pdfPath = source.pdfPath;
      sourceMeta = source.metadata as { normalExtractEnglish?: Record<string, unknown>; normalExtractChinese?: Record<string, unknown> } | null;
      // Inherit answer/skip page metadata from source too — the clone
      // doesn't carry these per-paper settings.
      if (!(paper.metadata as { answerPages?: unknown } | null)?.answerPages) metaForDrop = source.metadata;
    }
    if (source?.id && !pdfPath) {
      // No source PDF either, but the source's page JPEGs may still
      // be on disk — use those for the fallback below.
      pageImagesOwnerId = source.id;
      sourceMeta = source.metadata as { normalExtractEnglish?: Record<string, unknown>; normalExtractChinese?: Record<string, unknown> } | null;
      if (!(paper.metadata as { answerPages?: unknown } | null)?.answerPages) metaForDrop = source.metadata;
    }
  }

  // English gate: only allow Print on papers that have at least one
  // Normal Extract section flagged Done. Without bounds on the
  // questions the scan-back marker would just produce empty marks.
  const subjectLc = (paper.subject ?? "").toLowerCase();
  const subjectRawForGate = paper.subject ?? "";
  const isChineseSubject = subjectLc.includes("chinese") || subjectRawForGate.includes("华文") || subjectRawForGate.includes("中文") || subjectRawForGate.includes("华语");
  if (subjectLc.includes("english")) {
    const fromSource = sourceMeta?.normalExtractEnglish;
    const fromOwn = (paper.metadata as { normalExtractEnglish?: Record<string, unknown> } | null)?.normalExtractEnglish;
    const extractState = (fromSource ?? fromOwn) as Record<string, unknown> | undefined;
    const hasAnyExtract = !!extractState && Object.entries(extractState).some(([k, v]) => k !== "lastRunAt" && v === true);
    if (!hasAnyExtract) {
      return NextResponse.json({
        error: "This paper has not been registered in system for printing.",
      }, { status: 400 });
    }
  }
  if (isChineseSubject) {
    const fromSource = sourceMeta?.normalExtractChinese;
    const fromOwn = (paper.metadata as { normalExtractChinese?: Record<string, unknown> } | null)?.normalExtractChinese;
    const extractState = (fromSource ?? fromOwn) as Record<string, unknown> | undefined;
    const hasAnyExtract = !!extractState && Object.entries(extractState).some(([k, v]) => k !== "lastRunAt" && v === true);
    if (!hasAnyExtract) {
      return NextResponse.json({
        error: "This paper has not been registered in system for printing.",
      }, { status: 400 });
    }
  }

  // Resolve the PDF path. Stored as a relative path under VOLUME_PATH.
  let pdfBytes: Buffer | null = null;
  if (pdfPath) {
    const absPath = path.isAbsolute(pdfPath)
      ? pdfPath
      : path.join(VOLUME_PATH, pdfPath);
    try {
      pdfBytes = await fs.readFile(absPath);
    } catch (err) {
      console.warn(`[print] PDF read failed, will fall back to page JPEGs: ${absPath}`, err);
    }
  }
  // Fallback: assemble a PDF from per-page JPEGs at /pages/<id>/page_N.jpg.
  // extract-background creates these on every upload but doesn't persist
  // the original PDF, so for those papers we round-trip image → PDF
  // here. The output is image-only (no selectable text) but visually
  // matches the source paper.
  if (!pdfBytes) {
    const pagesDir = path.join(VOLUME_PATH, "pages", pageImagesOwnerId);
    try {
      const files = (await fs.readdir(pagesDir))
        .filter(f => /^page_\d+\.jpg$/i.test(f))
        .sort((a, b) => {
          const an = parseInt(a.match(/^page_(\d+)/)![1], 10);
          const bn = parseInt(b.match(/^page_(\d+)/)![1], 10);
          return an - bn;
        });
      if (files.length === 0) throw new Error("no page JPEGs on disk");
      const assembled = await PDFDocument.create();
      // Fit each JPEG to A4, preserving aspect ratio. Setting the
      // page size to the JPEG's pixel dimensions (~2000×2800 for a
      // typical scan) produced an oversized page that home printers
      // truncated to letter-width — symptom: right half of every page
      // cut off. Standard A4 + scale-to-fit means home / mobile
      // printers print the whole page at the expected scale.
      const A4_W = 595;
      const A4_H = 842;
      for (const f of files) {
        const jpg = await fs.readFile(path.join(pagesDir, f));
        const img = await assembled.embedJpg(jpg);
        // Pick page orientation by image aspect ratio so wide scans
        // (e.g. two facing pages rendered together) get a landscape A4
        // and aren't squashed into portrait.
        const landscape = img.width > img.height;
        const pageW = landscape ? A4_H : A4_W;
        const pageH = landscape ? A4_W : A4_H;
        const scale = Math.min(pageW / img.width, pageH / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const drawX = (pageW - drawW) / 2;
        const drawY = (pageH - drawH) / 2;
        const p = assembled.addPage([pageW, pageH]);
        p.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
      }
      pdfBytes = Buffer.from(await assembled.save());
      console.log(`[print] assembled ${files.length}-page PDF from JPEGs for owner=${pageImagesOwnerId} (this paper had no pdfPath)`);
    } catch (err) {
      console.error(`[print] page-JPEG fallback failed for owner=${pageImagesOwnerId}:`, err);
      return NextResponse.json({ error: "No source PDF and no page images on disk for this paper" }, { status: 400 });
    }
  }

  // Drop answer-key + skip pages so the parent only prints the question
  // pages. answerPages / skipPages are 1-based; pdf-lib removePage() is
  // 0-based, so we shift and remove from highest → lowest index to keep
  // earlier indices stable.
  const doc = await PDFDocument.load(pdfBytes);
  const meta = (metaForDrop ?? null) as { answerPages?: number[]; skipPages?: number[] } | null;
  const pagesToDrop = new Set<number>([
    ...(meta?.answerPages ?? []).map(p => p - 1),
    ...(meta?.skipPages ?? []).map(p => p - 1),
  ]);
  if (pagesToDrop.size > 0) {
    const sorted = Array.from(pagesToDrop).filter(i => i >= 0 && i < doc.getPageCount()).sort((a, b) => b - a);
    for (const i of sorted) doc.removePage(i);
  }

  // Build originalPageIndex → printedPageIndex map. The exam print
  // doesn't re-layout questions on new pages — it just drops hidden
  // pages from the master PDF — so each question's y-coordinates
  // stay valid on the page they always lived on, and only the page-
  // index needs to shift to account for the removed pages above it.
  // Stamping printableBounds with this mapping lets the mark router
  // detect "this was printed-and-scanned" on the strong signal (no
  // need to fall back to metadata.skipPages) AND gives the scan-back
  // marker precise per-question crops.
  const originalPageCount = (await PDFDocument.load(pdfBytes)).getPageCount();
  const printedPageOf = new Map<number, number>();
  let printedIdx = 0;
  for (let origIdx = 0; origIdx < originalPageCount; origIdx++) {
    if (pagesToDrop.has(origIdx)) continue;
    printedPageOf.set(origIdx, printedIdx);
    printedIdx++;
  }
  const pages = doc.getPages();
  if (pages.length === 0) {
    return NextResponse.json({ error: "Empty PDF after removing answer pages" }, { status: 500 });
  }
  const page = pages[0];
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const code = `MFY-${id.slice(0, 8)}-${studentId.slice(0, 8)}`;
  const fontSize = 9;
  const textWidth = font.widthOfTextAtSize(code, fontSize);
  const { width, height } = page.getSize();
  // Pad from page edges.
  const padX = 16;
  const padY = 16;
  const boxPad = 3;

  // ── Top-centre instructions banner ────────────────────────────
  // Big bold blue notice stamped at the top of page 1 so the student
  // sees it the moment the paper is in their hands. One short line
  // covering both expectations the marker depends on: legible blue
  // ink + a full scan submission. Larger than the previous 11pt /
  // 2-line layout because it has to read from across the room.
  const noticeLines = [
    "Please write legibly in blue ink. Scan every page for submission.",
  ];
  const noticeSize = 18;
  const noticeLineH = noticeSize + 6;
  const noticeInnerPadY = 12;
  const noticeBoxH = noticeLines.length * noticeLineH + noticeInnerPadY * 2;
  const noticeBoxX = padX;
  const noticeBoxW = width - padX * 2;
  const noticeBoxY = height - padY - noticeBoxH;
  // White fill so the box stays readable on busy paper headers,
  // brand-blue border so it stands out.
  page.drawRectangle({
    x: noticeBoxX,
    y: noticeBoxY,
    width: noticeBoxW,
    height: noticeBoxH,
    color: rgb(1, 1, 1),
    opacity: 0.95,
    borderColor: rgb(0, 0.12, 0.25),
    borderWidth: 1.2,
  });
  let nty = noticeBoxY + noticeBoxH - noticeInnerPadY - noticeSize;
  for (const line of noticeLines) {
    const lw = font.widthOfTextAtSize(line, noticeSize);
    page.drawText(line, {
      x: (width - lw) / 2,
      y: nty,
      size: noticeSize,
      font,
      color: rgb(0, 0.12, 0.25),
    });
    nty -= noticeLineH;
  }

  // Print code: tucked top-right just below the notice box so the
  // OCR-based scan matcher (inbound-email + scan-submit) still
  // finds it, without colliding with the banner above.
  const x = width - textWidth - padX;
  const y = noticeBoxY - boxPad - fontSize - 4;
  page.drawRectangle({
    x: x - boxPad,
    y: y - boxPad,
    width: textWidth + boxPad * 2,
    height: fontSize + boxPad * 2,
    color: rgb(1, 1, 1),
    opacity: 0.85,
  });
  page.drawText(code, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });

  // Chinese-only: append the 阅读理解 OEQ writing pad to the end of
  // the print. Generated by /api/admin/exam/[id]/chinese-oeq-pad
  // and cached at /pages/<paperId>/oeq_pad.pdf. The scan-back marker
  // has bounds on Q33-Q40 pointing at these appended pages.
  if (isChineseSubject) {
    // For Test Quiz clones, the pad lives on the source master.
    const padOwnerId = paper.pdfPath ? id : (paper.sourceExamId ?? id);
    const padPath = path.join(VOLUME_PATH, "pages", padOwnerId, "oeq_pad.pdf");
    try {
      const padBytes = await fs.readFile(padPath);
      const padDoc = await PDFDocument.load(padBytes);
      const padPages = await doc.copyPages(padDoc, padDoc.getPageIndices());
      for (const p of padPages) doc.addPage(p);
    } catch {
      // Pad not generated → just print the paper without it.
      // (Admin can hit chinese-normal-extract → 阅读理解 OEQ to
      // generate.)
    }
  }

  const out = await doc.save();
  // Build a clean filename from the paper title.
  const safeTitle = (paper.title ?? "Exam").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 80) || "Exam";
  const filename = `${safeTitle} (print).pdf`;

  // Stamp printableBounds on every question of THIS paper (the clone
  // if printed from an assigned paper, the master if printed directly).
  // Bounds carry { pageIndex: <position in printed PDF>, yStartPct,
  // yEndPct } — same shape the focused-test printable route uses. The
  // mark router checks for any question with printableBounds set as
  // its primary "this was scanned back" signal, so stamping these
  // restores accurate routing on the strong signal AND gives the
  // scan-back marker precise crops. Best-effort: failures are logged
  // but don't block the PDF response.
  prisma.examQuestion.findMany({
    where: { examPaperId: id },
    select: { id: true, pageIndex: true, yStartPct: true, yEndPct: true, printableBounds: true },
  }).then(async qs => {
    const updates = [];
    for (const q of qs) {
      if (q.printableBounds) continue; // idempotent — don't overwrite
      const printedPageIndex = printedPageOf.get(q.pageIndex);
      if (printedPageIndex === undefined) continue; // question on a dropped page (shouldn't happen)
      if (q.yStartPct == null || q.yEndPct == null) continue;
      const bounds = {
        pageIndex: printedPageIndex,
        yStartPct: q.yStartPct,
        yEndPct: q.yEndPct,
      };
      updates.push(
        prisma.examQuestion.update({
          where: { id: q.id },
          data: { printableBounds: bounds },
        }).catch(err => console.warn(`[print] failed to set printableBounds for q=${q.id}:`, err))
      );
    }
    if (updates.length > 0) {
      await Promise.all(updates);
      console.log(`[print] stamped printableBounds on ${updates.length}/${qs.length} questions for paper ${id}`);
    }
  }).catch(err => console.warn(`[print] failed to stamp printableBounds batch for ${id}:`, err));

  // Stamp printedAt so the student homepage can show the self-serve
  // scan-back camera icon for this assignment. Best-effort — never
  // block the PDF response if the update errors.
  //
  // Two writes when the print was scoped to a specific student:
  //   1. the paper in the URL (master or a clone) — backwards
  //      compatible with the original camera-icon flow.
  //   2. the student's actual assigned clone of this paper — that's
  //      the row the StudentDashboard renders, so without this stamp
  //      the camera stayed hidden even after a parent printed from
  //      the master papers list.
  prisma.examPaper.updateMany({
    where: { id, printedAt: null },
    data: { printedAt: new Date() },
  }).catch(err => console.warn(`[print] failed to stamp printedAt for ${id}:`, err));
  if (studentId) {
    // Find the student's assigned clone whose source is this paper
    // (or whose own id is this paper if printing directly from a
    // pre-assigned clone). Match defensively in case of duplicate
    // assignments — updateMany is idempotent.
    prisma.examPaper.updateMany({
      where: {
        assignedToId: studentId,
        printedAt: null,
        OR: [{ sourceExamId: id }, { id }],
      },
      data: { printedAt: new Date() },
    }).catch(err => console.warn(`[print] failed to stamp student clone printedAt for student=${studentId} src=${id}:`, err));
  }

  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
