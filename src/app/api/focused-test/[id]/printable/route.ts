import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import { prisma } from "@/lib/db";

// GET /api/focused-test/[id]/printable?studentId=<id>&userId=<parent>
//
// Renders a focused-practice paper as a printable A4 PDF. Cover page
// has the title + student name + subject + level + the print code
// MFY-<paper8>-<student8> stamped top-right (same format the inbound
// scan webhook matches against). Each question's stored imageData is
// drawn at full natural width, then a working area is added below
// sized by subject + marks:
//   Math OEQ:    ~10% of A4 height per mark
//   Science OEQ: 2 lines per mark (~16pt each)
//   MCQ:         1 short answer line ('Answer: ___')
// Auto-overflow: if the next question wouldn't fit, push it to a new page.

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 40;
const CONTENT_W = A4_W - MARGIN * 2;
const LINE_PT = 16;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const studentId = request.nextUrl.searchParams.get("studentId");
  const userId = request.nextUrl.searchParams.get("userId");
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const [paper, student, requester] = await Promise.all([
    prisma.examPaper.findUnique({
      where: { id },
      select: {
        id: true, title: true, subject: true, level: true, paperType: true,
        userId: true, assignedToId: true,
        questions: {
          orderBy: { orderIndex: "asc" },
          select: {
            id: true, questionNum: true, imageData: true, answer: true,
            marksAvailable: true, transcribedOptions: true, transcribedStem: true,
          },
        },
      },
    }),
    prisma.user.findUnique({ where: { id: studentId }, select: { id: true, name: true, level: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, parentLinks: { select: { studentId: true } } },
    }),
  ]);

  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  if (!requester) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const isAdmin = requester.name?.toLowerCase() === "admin";
  const isOwner = paper.userId === userId;
  const isLinked = requester.parentLinks.some(l => l.studentId === studentId);
  if (!isAdmin && !isOwner && !isLinked) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const isMath = (paper.subject ?? "").toLowerCase().includes("math");
  const isScience = (paper.subject ?? "").toLowerCase().includes("sci");
  const code = `MFY-${paper.id.slice(0, 8)}-${student.id.slice(0, 8)}`;

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Cover page ────────────────────────────────────────────────
  let page = doc.addPage([A4_W, A4_H]);
  drawPrintCode(page, helvBold, code);
  drawCoverPage(page, helvBold, helv, paper.title ?? "Focused Practice", student.name, paper.subject ?? "", paper.level ?? "", paper.questions.length, code);

  // ── Question pages ────────────────────────────────────────────
  // We start a new page for the first question — keeps the cover
  // self-contained and gives the student a clean writing surface.
  let yCursor = A4_H - MARGIN;
  page = doc.addPage([A4_W, A4_H]);
  drawPrintCode(page, helvBold, code);
  yCursor = A4_H - MARGIN - 18; // print code height

  for (let qi = 0; qi < paper.questions.length; qi++) {
    const q = paper.questions[qi];
    const isMcq = isMcqQuestion(q);
    const marks = q.marksAvailable ?? 1;

    // Embed the question crop at full content width; preserve aspect.
    let imgH = 0;
    let imgEmbed: Awaited<ReturnType<typeof doc.embedJpg>> | Awaited<ReturnType<typeof doc.embedPng>> | null = null;
    if (q.imageData) {
      try {
        const { embed, height } = await embedDataUrlScaled(doc, q.imageData, CONTENT_W);
        imgEmbed = embed;
        imgH = height;
      } catch (err) {
        console.warn(`[printable] image embed failed for Q${q.questionNum}:`, err);
      }
    }

    // Compute working area height needed.
    const workingH = isMcq
      ? LINE_PT * 1.6 // single answer line
      : isMath
        ? Math.max(LINE_PT * 4, marks * A4_H * 0.10)
        : isScience
          ? Math.max(LINE_PT * 2, marks * 2 * LINE_PT)
          : LINE_PT * 2 * marks; // fallback similar to science

    const labelH = LINE_PT * 1.5; // 'Q12 (2 marks)' header
    const totalNeeded = labelH + imgH + 8 + workingH + 12; // + spacing

    // Page-break if not enough room. Always push to new page if first
    // question on the page wouldn't fit either (shouldn't happen at
    // sensible sizes, but keeps us safe).
    const spaceLeft = yCursor - MARGIN;
    if (totalNeeded > spaceLeft) {
      page = doc.addPage([A4_W, A4_H]);
      drawPrintCode(page, helvBold, code);
      yCursor = A4_H - MARGIN - 18;
    }

    // Question label
    const label = `Q${q.questionNum}${marks > 1 ? `   (${marks} marks)` : marks === 1 ? `   (1 mark)` : ""}`;
    page.drawText(label, { x: MARGIN, y: yCursor - 11, size: 11, font: helvBold, color: rgb(0, 0, 0) });
    yCursor -= labelH;

    // Question image
    if (imgEmbed && imgH > 0) {
      page.drawImage(imgEmbed, { x: MARGIN, y: yCursor - imgH, width: CONTENT_W, height: imgH });
      yCursor -= imgH + 6;
    } else if (q.transcribedStem) {
      const lines = wrapLines(q.transcribedStem, helv, 11, CONTENT_W);
      for (const line of lines) {
        page.drawText(line, { x: MARGIN, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
        yCursor -= LINE_PT;
      }
    }

    // Working area
    if (isMcq) {
      page.drawText("Answer:", { x: MARGIN, y: yCursor - 11, size: 11, font: helvBold });
      page.drawLine({ start: { x: MARGIN + 60, y: yCursor - 13 }, end: { x: MARGIN + 200, y: yCursor - 13 }, thickness: 0.6, color: rgb(0, 0, 0) });
      yCursor -= LINE_PT * 1.6;
    } else if (isMath) {
      // Plain working space — no lines, just a box outline so the
      // student knows where to write. ~10% page height per mark.
      const h = workingH;
      page.drawRectangle({ x: MARGIN, y: yCursor - h, width: CONTENT_W, height: h, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.6 });
      yCursor -= h;
    } else {
      // Science (or fallback): 2 lines per mark.
      const lines = Math.max(2, Math.round(marks * 2));
      for (let i = 0; i < lines; i++) {
        const yLine = yCursor - (i + 1) * LINE_PT;
        page.drawLine({ start: { x: MARGIN, y: yLine }, end: { x: MARGIN + CONTENT_W, y: yLine }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
      }
      yCursor -= lines * LINE_PT;
    }

    yCursor -= 12; // gap to next question
  }

  const bytes = await doc.save();
  const safeTitle = (paper.title ?? "Focused Practice").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 80) || "Focused Practice";
  const filename = `${safeTitle} (printable).pdf`;
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function isMcqQuestion(q: { transcribedOptions?: unknown; answer?: string | null }): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length >= 2) return true;
  const a = (q.answer ?? "").trim();
  return /^[A-D1-4]$/i.test(a);
}

function drawPrintCode(page: PDFPage, font: PDFFont, code: string) {
  const fontSize = 9;
  const w = font.widthOfTextAtSize(code, fontSize);
  const x = A4_W - w - MARGIN;
  const y = A4_H - 24;
  // White rectangle behind so the code stays readable on busy pages.
  page.drawRectangle({ x: x - 4, y: y - 3, width: w + 8, height: fontSize + 6, color: rgb(1, 1, 1), opacity: 0.85 });
  page.drawText(code, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
}

function drawCoverPage(page: PDFPage, bold: PDFFont, regular: PDFFont, title: string, studentName: string, subject: string, level: string, qCount: number, code: string) {
  // Big title
  let y = A4_H - 200;
  page.drawText("Focused Practice", { x: MARGIN, y, size: 28, font: bold, color: rgb(0, 0.12, 0.25) });
  y -= 36;
  // Subtitle line: subject · level · question count
  const sub = [subject, level ? `Primary ${level}` : "", `${qCount} questions`].filter(Boolean).join("  ·  ");
  page.drawText(sub, { x: MARGIN, y, size: 14, font: regular, color: rgb(0.3, 0.3, 0.3) });
  y -= 50;
  // Student name (large)
  page.drawText("Student", { x: MARGIN, y, size: 11, font: regular, color: rgb(0.4, 0.4, 0.4) });
  y -= 18;
  page.drawText(studentName, { x: MARGIN, y, size: 22, font: bold, color: rgb(0, 0.12, 0.25) });
  y -= 50;
  // Topic
  if (title) {
    page.drawText("Topic", { x: MARGIN, y, size: 11, font: regular, color: rgb(0.4, 0.4, 0.4) });
    y -= 18;
    const lines = wrapLines(title, bold, 16, CONTENT_W);
    for (const line of lines) {
      page.drawText(line, { x: MARGIN, y, size: 16, font: bold, color: rgb(0, 0.12, 0.25) });
      y -= 22;
    }
  }

  // Instructions block at bottom
  const instructions = [
    "1. Write your name and date below.",
    "2. Answer every question.",
    "3. Show your working for math questions.",
    "4. When done, ask your parent to scan the pages and email the scan to hello@inbound.markforyou.com.",
    "5. The code in the top-right of each page tells us which paper this is — please don't cover or cut it off.",
  ];
  let iy = 240;
  page.drawText("Instructions", { x: MARGIN, y: iy, size: 12, font: bold, color: rgb(0, 0.12, 0.25) });
  iy -= 20;
  for (const line of instructions) {
    const wrapped = wrapLines(line, regular, 10, CONTENT_W);
    for (const w of wrapped) {
      page.drawText(w, { x: MARGIN, y: iy, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
      iy -= 14;
    }
  }

  // Name + date lines
  let ny = 130;
  page.drawText("Name:", { x: MARGIN, y: ny, size: 11, font: bold });
  page.drawLine({ start: { x: MARGIN + 50, y: ny - 2 }, end: { x: MARGIN + 250, y: ny - 2 }, thickness: 0.6 });
  page.drawText("Date:", { x: MARGIN + 280, y: ny, size: 11, font: bold });
  page.drawLine({ start: { x: MARGIN + 320, y: ny - 2 }, end: { x: A4_W - MARGIN, y: ny - 2 }, thickness: 0.6 });
  ny -= 30;
  page.drawText(`Code: ${code}`, { x: MARGIN, y: ny, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });
}

async function embedDataUrlScaled(doc: PDFDocument, dataUrl: string, targetWidth: number): Promise<{ embed: Awaited<ReturnType<typeof doc.embedJpg>>; height: number }> {
  const isPng = dataUrl.startsWith("data:image/png");
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  const embed = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const ratio = targetWidth / embed.width;
  return { embed, height: embed.height * ratio };
}

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) out.push(current);
      current = w;
    }
  }
  if (current) out.push(current);
  return out;
}
