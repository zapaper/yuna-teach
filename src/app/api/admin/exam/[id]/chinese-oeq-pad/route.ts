// Generates the blank-answer writing pad PDF that gets appended to
// the end of Paper 2 for Chinese exam papers. Layout:
//
//   Page 1 — Q33 (long answer comprehension)
//     Q33 header + 9 horizontal writing rows (~half page tall)
//
//   Page 2 — Q34 through Q40 (short answer)
//     Each question gets a header (label + [N marks]) and
//     (marksAvailable × 2) horizontal writing rows.
//
// The PDF is stored on the master paper's pages dir as
//   /pages/<paperId>/oeq_pad.pdf
// so the print flow can fetch + append it without re-generating.
// Re-running the POST overwrites the cached PDF.
//
// Triggered from /exam/[id]/chinese-normal-extract via the
// 阅读理解 OEQ button. After generation, the page previews the
// PDF inline with an <iframe src=…/chinese-oeq-pad/>.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const HEADER_HEIGHT = 24;
const Q33_ROW_HEIGHT = 52;   // ~half-page worth for 9 rows
const SHORT_ROW_HEIGHT = 24;
const SHORT_Q_GAP = 12;

type OeqQuestion = { questionNum: string; marksAvailable: number | null };

async function generatePadPdf(oeqQuestions: OeqQuestion[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Sort by questionNum so Q33 leads and Q34+ follow.
  const sorted = [...oeqQuestions].sort((a, b) => {
    const an = parseInt(a.questionNum, 10);
    const bn = parseInt(b.questionNum, 10);
    return (Number.isFinite(an) ? an : 999) - (Number.isFinite(bn) ? bn : 999);
  });
  const q33 = sorted.find(q => q.questionNum === "33");
  const others = sorted.filter(q => q.questionNum !== "33");

  // ─── Page 1: Q33 ───────────────────────────────────────────
  const p1 = doc.addPage([PAGE_W, PAGE_H]);
  const marks33 = q33?.marksAvailable ?? 10;
  p1.drawText("33.", { x: MARGIN, y: PAGE_H - MARGIN, size: 14, font: helvBold });
  p1.drawText(`[${marks33} marks]`, { x: MARGIN + 40, y: PAGE_H - MARGIN, size: 11, font: helv, color: rgb(0.4, 0.4, 0.4) });
  const startY1 = PAGE_H - MARGIN - HEADER_HEIGHT;
  for (let i = 0; i < 9; i++) {
    const y = startY1 - i * Q33_ROW_HEIGHT;
    p1.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.6,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  // ─── Page 2 (and overflow if needed): Q34-Q40 ──────────────
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - MARGIN;
  for (const q of others) {
    const marks = q.marksAvailable ?? 1;
    const rows = Math.max(1, marks * 2);
    const blockHeight = HEADER_HEIGHT + rows * SHORT_ROW_HEIGHT + SHORT_Q_GAP;
    // New page when this block won't fit.
    if (cursorY - blockHeight < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursorY = PAGE_H - MARGIN;
    }
    page.drawText(`${q.questionNum}.`, { x: MARGIN, y: cursorY - 12, size: 12, font: helvBold });
    page.drawText(`[${marks} mark${marks === 1 ? "" : "s"}]`, { x: MARGIN + 34, y: cursorY - 12, size: 10, font: helv, color: rgb(0.4, 0.4, 0.4) });
    cursorY -= HEADER_HEIGHT;
    for (let i = 0; i < rows; i++) {
      const y = cursorY - i * SHORT_ROW_HEIGHT;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.5,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
    cursorY -= rows * SHORT_ROW_HEIGHT + SHORT_Q_GAP;
  }

  return await doc.save();
}

// POST — regenerate + cache the pad PDF.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { id } = await params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, subject: true, metadata: true,
      questions: {
        select: { questionNum: true, marksAvailable: true, syllabusTopic: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  const subjRaw = paper.subject ?? "";
  const subjLower = subjRaw.toLowerCase();
  const isChinese = subjLower.includes("chinese") || subjRaw.includes("华文") || subjRaw.includes("中文") || subjRaw.includes("华语");
  if (!isChinese) {
    return NextResponse.json({ error: "This route is Chinese-only." }, { status: 400 });
  }

  // Pull OEQ questions — anything tagged 阅读理解 OEQ (any A/B split).
  const oeqQuestions: OeqQuestion[] = paper.questions
    .filter(q => /阅读理解.*OEQ/i.test(q.syllabusTopic ?? ""))
    .map(q => ({ questionNum: q.questionNum, marksAvailable: q.marksAvailable }));
  if (oeqQuestions.length === 0) {
    return NextResponse.json({
      error: "No 阅读理解 OEQ questions found on this paper. Run Clean Extract first so each OEQ is tagged with its syllabusTopic.",
    }, { status: 400 });
  }

  const pdfBytes = await generatePadPdf(oeqQuestions);

  // Cache to disk so the print flow can append it without
  // re-generating.
  const dir = path.join(PAGES_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "oeq_pad.pdf");
  await fs.writeFile(filePath, pdfBytes);

  // Flag the section as done so the admin papers badge picks it up.
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const ne = (meta.normalExtractChinese ?? {}) as Record<string, unknown>;
  await prisma.examPaper.update({
    where: { id },
    data: {
      metadata: {
        ...meta,
        normalExtractChinese: {
          ...ne,
          compOeq: true,
          oeqPadPages: oeqQuestions.length > 0 ? Math.max(1, Math.ceil((oeqQuestions.length - 1) / 4) + 1) : 0,
          lastRunAt: new Date().toISOString(),
        },
      } as object,
    },
  });

  return NextResponse.json({
    ok: true,
    questionCount: oeqQuestions.length,
    questions: oeqQuestions,
    bytes: pdfBytes.length,
    previewUrl: `/api/admin/exam/${id}/chinese-oeq-pad`,
  });
}

// GET — serve the cached pad PDF for preview / for the print flow.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { id } = await params;
  const filePath = path.join(PAGES_DIR, id, "oeq_pad.pdf");
  try {
    const buf = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="oeq_pad.pdf"`,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch {
    return NextResponse.json({ error: "Pad not generated yet — POST first." }, { status: 404 });
  }
}
