import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isAdmin as isAdminUser } from "@/lib/admin";

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

// pdf-lib's Helvetica uses WinAnsi encoding — common Unicode math
// symbols like π, ×, ÷, ² etc. throw "WinAnsi cannot encode …" at
// drawText time. Map the symbols we actually see in question
// content to ASCII or escape the rest as a "?" so the PDF builds
// instead of 500-erroring. Lossy but the alternative is shipping
// a Unicode font (~hundreds of KB) embedded in every print job.
const ASCII_MAP: Record<string, string> = {
  "π": "pi",
  "×": "x",
  "÷": "/",
  "·": ".",
  "−": "-",
  "–": "-",
  "—": "-",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≈": "~=",
  "→": "->",
  "←": "<-",
  "↑": "^",
  "↓": "v",
  "²": "^2",
  "³": "^3",
  "°": " deg",
  "√": "sqrt",
  "¼": "1/4",
  "½": "1/2",
  "¾": "3/4",
  "‘": "'",
  "’": "'",
  "“": "\"",
  "”": "\"",
  " ": " ", // nbsp
};
function sanitizeForWinAnsi(text: string): string {
  if (!text) return "";
  let out = "";
  for (const ch of text) {
    if (ch in ASCII_MAP) {
      out += ASCII_MAP[ch];
      continue;
    }
    const code = ch.charCodeAt(0);
    // WinAnsi covers basic Latin (0x20-0x7E) + a chunk of high-bytes;
    // anything outside U+0000 - U+00FF risks erroring. Drop chars
    // outside that range to "?" so the rest of the line still
    // prints.
    if (code > 0xff) out += "?";
    else out += ch;
  }
  return out;
}

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
            transcribedSubparts: true, diagramImageData: true,
          },
        },
      },
    }),
    prisma.user.findUnique({ where: { id: studentId }, select: { id: true, name: true, level: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, settings: true, parentLinks: { select: { studentId: true } } },
    }),
  ]);

  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  if (!requester) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const isAdmin = isAdminUser(requester);
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

  // Embed the MarkForYou brand assets so the cover page can use
  // them. Best-effort — if either file is missing, the cover
  // gracefully falls back to text-only.
  let owlLogo: PDFImage | null = null;
  let wordmark: PDFImage | null = null;
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", "logo_t.png"));
    owlLogo = await doc.embedPng(buf);
  } catch { /* missing in some environments */ }
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", "markforyou2_t.png"));
    wordmark = await doc.embedPng(buf);
  } catch { /* missing — fall back to drawn text */ }

  // What kind of paper are we printing? Drives the heading on
  // the cover ("Quiz" vs "Focused Practice" vs "Practice").
  const paperKind = paper.paperType === "quiz" ? "Quiz"
    : paper.paperType === "focused" ? "Focused Practice"
    : "Practice";

  // ── Cover page ────────────────────────────────────────────────
  let page = doc.addPage([A4_W, A4_H]);
  drawPrintCode(page, helvBold, code);
  drawCoverPage(page, helvBold, helv, {
    owlLogo,
    wordmark,
    paperKind,
    topic: paper.title ?? paperKind,
    studentName: student.name,
    subject: paper.subject ?? "",
    level: paper.level ?? "",
    questionCount: paper.questions.length,
    code,
  });

  // ── Question pages ────────────────────────────────────────────
  // Clean-extract render only — never embed q.imageData (raw scan
  // crop). Stem text comes from transcribedStem, sub-parts from
  // transcribedSubparts, MCQ options from transcribedOptions, and
  // diagrams from diagramImageData. Each question / sub-part's
  // writing-area Y bounds are captured in printableBounds and
  // persisted at the end so the marker can crop the right region
  // off scanned-back pages.
  let yCursor = A4_H - MARGIN;
  let pageIndex = 0;
  page = doc.addPage([A4_W, A4_H]);
  drawPrintCode(page, helvBold, code);
  yCursor = A4_H - MARGIN - 18;

  function newPage() {
    page = doc.addPage([A4_W, A4_H]);
    drawPrintCode(page, helvBold, code);
    yCursor = A4_H - MARGIN - 18;
    pageIndex++;
  }
  function pctFromY(y: number): number {
    // pdf-lib's coordinate origin is bottom-left. Convert to a
    // top-down percentage so the marking pipeline (which reads
    // images top-down) can use it directly.
    return ((A4_H - y) / A4_H) * 100;
  }

  type SubpartBounds = { pageIndex: number; yStartPct: number; yEndPct: number };
  type QuestionBounds = SubpartBounds & { subparts?: Record<string, SubpartBounds> };
  const boundsByQ = new Map<string, QuestionBounds>();

  for (let qi = 0; qi < paper.questions.length; qi++) {
    const q = paper.questions[qi];
    const isMcq = isMcqQuestion(q);
    const marks = q.marksAvailable ?? 1;

    // Sub-parts (real ones — drop sentinels like _drawable / _subref).
    type Subpart = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };
    const allSubs = Array.isArray(q.transcribedSubparts)
      ? (q.transcribedSubparts as Subpart[])
      : [];
    const realSubs = allSubs.filter((s) => s && typeof s.label === "string" && !s.label.startsWith("_"));
    const drawableDiagram = allSubs.find((s) => s.label === "_drawable")?.diagramBase64 ?? null;
    const cleanOpts = isMcq && Array.isArray(q.transcribedOptions)
      ? (q.transcribedOptions as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    // Question label
    const label = sanitizeForWinAnsi(`Q${q.questionNum}${marks > 1 ? `   (${marks} marks)` : marks === 1 ? `   (1 mark)` : ""}`);
    const labelH = LINE_PT * 1.5;
    if (yCursor - labelH < MARGIN) newPage();
    page.drawText(label, { x: MARGIN, y: yCursor - 11, size: 11, font: helvBold, color: rgb(0, 0, 0) });
    yCursor -= labelH;

    const qWriteStartY = yCursor;
    const qStartPage = pageIndex;

    // Stem text (always render, even alongside subparts — the stem
    // sets up context that subparts depend on).
    if (q.transcribedStem) {
      const lines = wrapLines(q.transcribedStem, helv, 11, CONTENT_W);
      for (const line of lines) {
        if (yCursor - LINE_PT < MARGIN) newPage();
        page.drawText(line, { x: MARGIN, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
        yCursor -= LINE_PT;
      }
      yCursor -= 4;
    }

    // Question-level diagram (the question's own picture if any —
    // not a per-subpart one).
    if (q.diagramImageData) {
      try {
        const { embed, height } = await embedDataUrlScaled(doc, q.diagramImageData, Math.min(CONTENT_W, A4_W * 0.6));
        if (yCursor - height < MARGIN) newPage();
        page.drawImage(embed, { x: MARGIN, y: yCursor - height, width: Math.min(CONTENT_W, A4_W * 0.6), height });
        yCursor -= height + 6;
      } catch (err) {
        console.warn(`[printable] diagram embed failed for Q${q.questionNum}:`, err);
      }
    }

    if (isMcq) {
      // MCQ options + answer line. No sub-parts loop here even if
      // transcribedSubparts is set — MCQ is single-answer.
      for (let oi = 0; oi < cleanOpts.length; oi++) {
        const optLines = wrapLines(cleanOpts[oi], helv, 11, CONTENT_W - 24);
        for (let li = 0; li < optLines.length; li++) {
          if (yCursor - LINE_PT < MARGIN) newPage();
          const text = li === 0 ? `(${oi + 1})  ${optLines[li]}` : optLines[li];
          const x = MARGIN + (li === 0 ? 0 : 24);
          page.drawText(text, { x, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
          yCursor -= LINE_PT;
        }
      }
      // Single short answer line for MCQ
      yCursor -= 6;
      const ansY = yCursor - 11;
      const ansBoxStartY = yCursor;
      page.drawText("Answer:", { x: MARGIN, y: ansY, size: 11, font: helvBold, color: rgb(0, 0, 0) });
      page.drawLine({ start: { x: MARGIN + 60, y: ansY - 2 }, end: { x: MARGIN + 180, y: ansY - 2 }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });
      yCursor -= LINE_PT;
      const ansBoxEndY = yCursor;
      boundsByQ.set(q.id, {
        pageIndex: qStartPage,
        yStartPct: pctFromY(ansBoxStartY),
        yEndPct: pctFromY(ansBoxEndY),
      });
    } else if (realSubs.length > 0) {
      // Multi-part OEQ. Each sub-part gets a labelled header, its
      // text, optional per-subpart diagram, and a writing area
      // sized by per-subpart marks (read from "[N]" in the text)
      // or proportional fallback.
      const subBounds: Record<string, SubpartBounds> = {};
      const totalSubMarks = realSubs.reduce((sum, sp) => {
        const m = String(sp.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
        return sum + (m ? parseInt(m[1], 10) : 0);
      }, 0);
      for (const sp of realSubs) {
        const m = String(sp.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
        const subMarks = m ? parseInt(m[1], 10) : (totalSubMarks > 0 ? marks * (1 / realSubs.length) : marks / realSubs.length);
        const subText = sanitizeForWinAnsi(`(${sp.label}) ${sp.text}`);
        const subTextLines = wrapLines(subText, helv, 11, CONTENT_W);
        for (const line of subTextLines) {
          if (yCursor - LINE_PT < MARGIN) newPage();
          page.drawText(line, { x: MARGIN, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
          yCursor -= LINE_PT;
        }
        // Per-subpart diagram
        const spDiagram = sp.diagramBase64 ?? sp.refImageBase64 ?? null;
        if (spDiagram) {
          try {
            const { embed, height } = await embedDataUrlScaled(doc, spDiagram, Math.min(CONTENT_W, A4_W * 0.5));
            if (yCursor - height < MARGIN) newPage();
            page.drawImage(embed, { x: MARGIN, y: yCursor - height, width: Math.min(CONTENT_W, A4_W * 0.5), height });
            yCursor -= height + 4;
          } catch { /* skip on failure */ }
        }
        // Writing area sized by per-subpart marks
        const writeH = isMath
          ? Math.max(LINE_PT * 3, subMarks * A4_H * 0.085)
          : isScience
            ? Math.max(LINE_PT * 2, subMarks * 2 * LINE_PT)
            : Math.max(LINE_PT * 2, subMarks * 2 * LINE_PT);
        if (yCursor - writeH < MARGIN) newPage();
        const writeStartY = yCursor;
        const writeStartPage = pageIndex;
        if (isMath) {
          page.drawRectangle({ x: MARGIN, y: yCursor - writeH, width: CONTENT_W, height: writeH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.6 });
        } else {
          const linesN = Math.max(2, Math.round(subMarks * 2));
          for (let i = 0; i < linesN; i++) {
            const yLine = yCursor - (i + 1) * LINE_PT;
            page.drawLine({ start: { x: MARGIN, y: yLine }, end: { x: MARGIN + CONTENT_W, y: yLine }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
          }
        }
        yCursor -= writeH;
        const writeEndY = yCursor;
        subBounds[sp.label] = {
          pageIndex: writeStartPage,
          yStartPct: pctFromY(writeStartY),
          yEndPct: pctFromY(writeEndY),
        };
        yCursor -= 6;
      }
      const qEndY = yCursor;
      boundsByQ.set(q.id, {
        pageIndex: qStartPage,
        yStartPct: pctFromY(qWriteStartY),
        yEndPct: pctFromY(qEndY),
        subparts: subBounds,
      });
    } else {
      // Single-part OEQ. One writing area sized by total marks.
      // Drawable-diagram subpart (if any) goes inside the writing
      // box as a background.
      const writeH = isMath
        ? Math.max(LINE_PT * 4, marks * A4_H * 0.10)
        : isScience
          ? Math.max(LINE_PT * 2, marks * 2 * LINE_PT)
          : Math.max(LINE_PT * 2, marks * 2 * LINE_PT);
      if (yCursor - writeH < MARGIN) newPage();
      const writeStartY = yCursor;
      const writeStartPage = pageIndex;
      if (drawableDiagram) {
        try {
          const { embed, height } = await embedDataUrlScaled(doc, drawableDiagram, CONTENT_W);
          page.drawImage(embed, { x: MARGIN, y: yCursor - height, width: CONTENT_W, height });
        } catch { /* skip */ }
      }
      if (isMath) {
        page.drawRectangle({ x: MARGIN, y: yCursor - writeH, width: CONTENT_W, height: writeH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.6 });
      } else {
        const linesN = Math.max(2, Math.round(marks * 2));
        for (let i = 0; i < linesN; i++) {
          const yLine = yCursor - (i + 1) * LINE_PT;
          page.drawLine({ start: { x: MARGIN, y: yLine }, end: { x: MARGIN + CONTENT_W, y: yLine }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
        }
      }
      yCursor -= writeH;
      const writeEndY = yCursor;
      boundsByQ.set(q.id, {
        pageIndex: writeStartPage,
        yStartPct: pctFromY(writeStartY),
        yEndPct: pctFromY(writeEndY),
      });
    }

    yCursor -= 12;
  }

  // Persist the captured bounds so the marker can crop scanned
  // pages by question/sub-part. Best-effort — if the write fails
  // we still serve the PDF (parent can re-print to retry).
  await Promise.all(
    Array.from(boundsByQ.entries()).map(([qid, b]) =>
      prisma.examQuestion.update({
        where: { id: qid },
        data: { printableBounds: b as unknown as Prisma.InputJsonValue },
      }).catch((err) => {
        console.warn(`[printable] failed to persist bounds for q=${qid}:`, err);
      }),
    ),
  );

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

function drawEmailBanner(page: PDFPage, font: PDFFont) {
  // Centered banner at the very top of the cover page so parents know
  // immediately where to send the completed scan. Light accent fill +
  // brand blue text matches the rest of the cover styling.
  const text = "Please email to diagnose@inbound.markforyou.com when done";
  const fontSize = 11;
  const w = font.widthOfTextAtSize(text, fontSize);
  const padX = 14;
  const padY = 7;
  const bx = (A4_W - (w + padX * 2)) / 2;
  const by = A4_H - MARGIN - (fontSize + padY * 2);
  page.drawRectangle({
    x: bx, y: by,
    width: w + padX * 2, height: fontSize + padY * 2,
    color: rgb(0.86, 0.91, 1.0), // soft brand-light fill
    borderColor: rgb(0, 0.12, 0.25),
    borderWidth: 0.6,
  });
  page.drawText(text, {
    x: bx + padX,
    y: by + padY + 1,
    size: fontSize,
    font,
    color: rgb(0, 0.12, 0.25),
  });
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

type CoverArgs = {
  owlLogo: PDFImage | null;
  wordmark: PDFImage | null;
  paperKind: string;          // "Quiz" / "Focused Practice"
  topic: string;              // paper title — usually the topic
  studentName: string;
  subject: string;
  level: string;
  questionCount: number;
  code: string;
};
function drawCoverPage(page: PDFPage, bold: PDFFont, regular: PDFFont, args: CoverArgs) {
  const { owlLogo, wordmark, paperKind, topic, studentName, subject, level, questionCount } = args;

  // ── Brand block: owl logo + wordmark, centred ─────────────────
  // Logo sized so the owl + wordmark together feel "front and
  // centre" but don't crowd out the title underneath.
  const logoSize = 110;
  const wordmarkH = 36;
  // Total block height (logo + gap + wordmark) used to centre.
  let y = A4_H - 110; // anchor for the logo top
  if (owlLogo) {
    page.drawImage(owlLogo, {
      x: (A4_W - logoSize) / 2,
      y: y - logoSize,
      width: logoSize,
      height: logoSize,
    });
    y -= logoSize + 8;
  } else {
    y -= 20;
  }
  if (wordmark) {
    const aspect = wordmark.width / wordmark.height;
    const w = wordmarkH * aspect;
    page.drawImage(wordmark, {
      x: (A4_W - w) / 2,
      y: y - wordmarkH,
      width: w,
      height: wordmarkH,
    });
    y -= wordmarkH + 28;
  } else {
    // Fallback: draw the brand name as text
    const txt = "MarkForYou";
    const size = 28;
    const w = bold.widthOfTextAtSize(txt, size);
    page.drawText(txt, { x: (A4_W - w) / 2, y: y - size, size, font: bold, color: rgb(0, 0.12, 0.25) });
    y -= size + 28;
  }

  // ── Title: paper kind ("Quiz" / "Focused Practice"), centred ──
  const kindSize = 22;
  const kindW = bold.widthOfTextAtSize(paperKind, kindSize);
  page.drawText(paperKind, { x: (A4_W - kindW) / 2, y: y - kindSize, size: kindSize, font: bold, color: rgb(0.2, 0.2, 0.2) });
  y -= kindSize + 32;

  // ── "for STUDENT", centred ────────────────────────────────────
  const forLine = sanitizeForWinAnsi(`for ${studentName}`);
  const forSize = 16;
  const forW = regular.widthOfTextAtSize(forLine, forSize);
  page.drawText(forLine, { x: (A4_W - forW) / 2, y: y - forSize, size: forSize, font: regular, color: rgb(0.3, 0.3, 0.3) });
  y -= forSize + 36;

  // ── Topic line, centred ───────────────────────────────────────
  if (topic) {
    const topicLines = wrapLines(`Topic: ${topic}`, bold, 14, CONTENT_W);
    for (const line of topicLines) {
      const w = bold.widthOfTextAtSize(line, 14);
      page.drawText(line, { x: (A4_W - w) / 2, y: y - 14, size: 14, font: bold, color: rgb(0, 0.12, 0.25) });
      y -= 20;
    }
    y -= 4;
  }

  // ── Date line, centred ────────────────────────────────────────
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const dateLine = `Printed: ${today}`;
  const dateW = regular.widthOfTextAtSize(dateLine, 11);
  page.drawText(dateLine, { x: (A4_W - dateW) / 2, y: y - 11, size: 11, font: regular, color: rgb(0.45, 0.45, 0.45) });
  y -= 14;

  // ── Meta strip: subject · level · question count ──────────────
  const metaParts: string[] = [];
  if (subject) metaParts.push(subject);
  if (level) metaParts.push(`Primary ${level}`);
  metaParts.push(`${questionCount} question${questionCount === 1 ? "" : "s"}`);
  const meta = sanitizeForWinAnsi(metaParts.join("  ·  "));
  const metaW = regular.widthOfTextAtSize(meta, 11);
  page.drawText(meta, { x: (A4_W - metaW) / 2, y: y - 11, size: 11, font: regular, color: rgb(0.55, 0.55, 0.55) });
  y -= 30;

  // ── Instructions block at bottom ──────────────────────────────
  const instructions = [
    "1. Write your name and date below.",
    "2. Answer every question.",
    "3. Show your working for math questions.",
    "4. When completed, please scan with scanner button on your mobile/tablet.",
    "5. The code in the top-right of each page tells us which paper this is — please don't cover or cut it off.",
  ];
  let iy = 220;
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
  page.drawText(`Code: ${args.code}`, { x: MARGIN, y: ny, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });
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
  // Sanitize FIRST so width calculations match what's actually
  // drawn — π in text but drawn as "pi" would be 0 width here vs.
  // 2 chars worth at draw-time, breaking layout.
  const safe = sanitizeForWinAnsi(text);
  const words = safe.split(/\s+/);
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
