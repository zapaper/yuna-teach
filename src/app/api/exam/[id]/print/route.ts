import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { prisma } from "@/lib/db";

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
  const userId = request.nextUrl.searchParams.get("userId");

  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Verify the requester is the parent (or an admin) and is linked to
  // the named student. Anything that fails this check is rejected so
  // we don't leak papers via the print URL.
  const [paper, parent, link] = await Promise.all([
    prisma.examPaper.findUnique({
      where: { id },
      select: { id: true, title: true, pdfPath: true, metadata: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    }),
    prisma.parentStudent.findFirst({
      where: { parentId: userId, studentId },
      select: { id: true },
    }),
  ]);

  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!paper.pdfPath) {
    return NextResponse.json({ error: "No source PDF for this paper" }, { status: 400 });
  }
  if (!parent) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // Admins can print for any linked student; non-admins must have the
  // parent-student link.
  const isAdmin = parent.name?.toLowerCase() === "admin";
  if (!isAdmin && !link) {
    return NextResponse.json({ error: "Not linked to that student" }, { status: 403 });
  }

  // Resolve the PDF path. Stored as a relative path under VOLUME_PATH.
  const absPath = path.isAbsolute(paper.pdfPath)
    ? paper.pdfPath
    : path.join(VOLUME_PATH, paper.pdfPath);
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
  const meta = (paper.metadata ?? null) as { answerPages?: number[]; skipPages?: number[] } | null;
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
  // Pad 16 pt from edges; draw a faint white box behind so the code
  // remains readable even over busy headers.
  const padX = 16;
  const padY = 16;
  const boxPad = 3;
  const x = width - textWidth - padX;
  const y = height - fontSize - padY;
  page.drawRectangle({
    x: x - boxPad,
    y: y - boxPad,
    width: textWidth + boxPad * 2,
    height: fontSize + boxPad * 2,
    color: rgb(1, 1, 1),
    opacity: 0.85,
  });
  page.drawText(code, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });

  const out = await doc.save();
  // Build a clean filename from the paper title.
  const safeTitle = (paper.title ?? "Exam").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 80) || "Exam";
  const filename = `${safeTitle} (print).pdf`;

  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
