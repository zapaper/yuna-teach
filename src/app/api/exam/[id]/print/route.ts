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
    select: { id: true, title: true, subject: true, pdfPath: true, metadata: true, sourceExamId: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // Clone fallback: Test Quiz clones (paperType="quiz") inherit
  // metadata from the master but don't carry their own pdfPath.
  // When the print route is asked to serve such a clone — happens
  // for English Test Quizzes routed here so the scan-back marker
  // can use the master's PDF layout + the clone's normal-extract
  // bounds — fall back to the source paper's PDF.
  let pdfPath = paper.pdfPath;
  let metaForDrop = paper.metadata;
  let sourceMeta: { normalExtractEnglish?: Record<string, unknown> } | null = null;
  if (!pdfPath && paper.sourceExamId) {
    const source = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { pdfPath: true, metadata: true },
    });
    if (source?.pdfPath) {
      pdfPath = source.pdfPath;
      sourceMeta = source.metadata as { normalExtractEnglish?: Record<string, unknown> } | null;
      // Inherit answer/skip page metadata from source too — the clone
      // doesn't carry these per-paper settings.
      if (!(paper.metadata as { answerPages?: unknown } | null)?.answerPages) metaForDrop = source.metadata;
    }
  }
  if (!pdfPath) {
    return NextResponse.json({ error: "No source PDF for this paper" }, { status: 400 });
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
        error: "This English paper hasn't run Normal Extract yet. Open /normal-extract on the master and run at least one section before printing.",
      }, { status: 400 });
    }
  }

  // Resolve the PDF path. Stored as a relative path under VOLUME_PATH.
  const absPath = path.isAbsolute(pdfPath)
    ? pdfPath
    : path.join(VOLUME_PATH, pdfPath);
  let pdfBytes: Buffer;
  try {
    pdfBytes = await fs.readFile(absPath);
  } catch (err) {
    console.error("[print] PDF read failed:", absPath, err);
    return NextResponse.json({ error: "PDF file missing on server" }, { status: 500 });
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
  // White-filled, blue-bordered box stamped at the top of page 1
  // so the parent sees the scan + ink instructions before they
  // print. Drawn FIRST so the print code below can clear it.
  const noticeLines = [
    "Use the App's scan function to submit (mobile only). Scan every page.",
    "Please write all answers in blue ink.",
  ];
  const noticeSize = 11;
  const noticeLineH = noticeSize + 4;
  const noticeInnerPadY = 9;
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

  // Stamp printedAt on first print so the student homepage can show
  // the self-serve scan-back camera icon for this assignment. Best-
  // effort — never block the PDF response if the update errors.
  prisma.examPaper.updateMany({
    where: { id, printedAt: null },
    data: { printedAt: new Date() },
  }).catch(err => console.warn(`[print] failed to stamp printedAt for ${id}:`, err));

  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
