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
// Margin set to ~6% (50pt of an 841pt A4) so home printers without
// borderless support don't clip the top/bottom row of content. Same
// value used for left/right — keeps the layout square and avoids
// any text bleeding into a printer's typical 0.5cm hardware margin.
const MARGIN = 50;
const CONTENT_W = A4_W - MARGIN * 2;
const LINE_PT = 16;
// Science OEQ writing lines sit 25% further apart than body text so
// students have more vertical room to write between rules.
const SCI_LINE_GAP = LINE_PT * 1.25;

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
// Transcribed text often contains LaTeX (\frac{1}{2}, \sqrt{16}, $x^2$,
// \times, \pi, ...) because the question rendering uses MathText/KaTeX
// elsewhere. pdf-lib's drawText is a plain raster draw — same constraint
// as canvas fillText — so anything left as raw LaTeX prints as literal
// backslash-gibberish. Map the common commands to their nearest
// readable form before WinAnsi sanitation strips the unicode further.
function flattenLatex(s: string): string {
  if (!s) return "";
  // For \frac{a}{b} and \sqrt{a}: skip the parens when `a` is a
  // single atomic token (digits, a single variable, decimal, optional
  // sign) so "1/4" doesn't become the ugly "(1)/(4)". Wrap only when
  // the contents have spaces or operators that need disambiguation.
  const atomic = (x: string) => x.trim();
  const wrapAtomic = (x: string) => {
    const t = atomic(x);
    return /^-?[\w.]+$/.test(t) ? t : `(${t})`;
  };
  return s
    // Strip $...$ / $$...$$ math delimiters but ONLY when the inside
    // actually looks like LaTeX (contains a backslash command or
    // math-only characters: ^, _, {, }). Plain dollar amounts in
    // English ("Mum earns $120 a day. Dad earns $200.") would
    // otherwise be matched pair-wise and have their $ signs stripped.
    .replace(/\$\$([^$]+)\$\$/g, (m, inner) => /[\\^_{}]/.test(inner) ? inner : m)
    .replace(/\$([^$]+)\$/g, (m, inner) => /[\\^_{}]/.test(inner) ? inner : m)
    // Fractions: nested-safe enough for the simple cases we see
    .replace(/\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, a, b) => `${wrapAtomic(a)}/${wrapAtomic(b)}`)
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, (_, a) => `√${wrapAtomic(a)}`)
    // Common math operators / symbols
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\cdot/g, "·")
    .replace(/\\pm/g, "±")
    .replace(/\\pi/g, "π")
    .replace(/\\degree|\\circ/g, "°")
    .replace(/\\le(?![a-z])/gi, "≤")
    .replace(/\\ge(?![a-z])/gi, "≥")
    .replace(/\\ne(?![a-z])/gi, "≠")
    .replace(/\\approx/g, "≈")
    .replace(/\\rightarrow|\\to(?![a-z])/g, "→")
    .replace(/\\leftarrow/g, "←")
    .replace(/\\infty/g, "∞")
    // Super/subscript with braces collapse
    .replace(/\^\{([^{}]+)\}/g, "^$1")
    .replace(/_\{([^{}]+)\}/g, "_$1")
    // Text wrappers — keep the inner text
    .replace(/\\(?:text|mathrm|mathit|mathbf|operatorname)\s*\{([^{}]+)\}/g, "$1")
    // Spacing macros
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\quad|\\qquad/g, "  ")
    // Strip remaining lone braces around plain chars
    .replace(/\{([^{}]*)\}/g, "$1")
    // Whatever's left of \command — drop the backslash, keep the word
    .replace(/\\([a-zA-Z]+)/g, "$1");
}

function sanitizeForWinAnsi(text: string): string {
  if (!text) return "";
  // Flatten LaTeX first so any unicode it emits (×, √, π, °, ...) is
  // then mapped to ASCII by the WinAnsi pass below.
  text = flattenLatex(text);
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
  // ?inline=1 → render the PDF inline so the client can embed it in
  // a hidden iframe and trigger window.print() directly instead of
  // downloading to disk.
  const inline = request.nextUrl.searchParams.get("inline") === "1";
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
            marksAvailable: true, transcribedOptions: true, transcribedOptionImages: true,
            transcribedStem: true, transcribedSubparts: true, diagramImageData: true,
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
  const isEnglish = (paper.subject ?? "").toLowerCase().includes("english");
  // English printable disabled for now — writing-comprehension layout
  // doesn't translate cleanly to lined / boxed A4 yet.
  if (isEnglish) {
    return NextResponse.json({ error: "Printable not available for English yet" }, { status: 400 });
  }
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
  // Cover is PDF page 1 — when the parent scans they'll capture it
  // as page_0.jpg, and the page number stamped at the bottom lets
  // them sanity-check that the scan order matches the PDF order.
  let pdfPageNum = 1;
  let page = doc.addPage([A4_W, A4_H]);
  drawPrintCode(page, helvBold, code);
  drawPageNumber(page, helv, pdfPageNum);
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
  pdfPageNum++;

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
  drawPageNumber(page, helv, pdfPageNum);
  pdfPageNum++;
  yCursor = A4_H - MARGIN - 18;

  function newPage() {
    page = doc.addPage([A4_W, A4_H]);
    drawPrintCode(page, helvBold, code);
    drawPageNumber(page, helv, pdfPageNum);
    pdfPageNum++;
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
    // Image options — array of base64 strings (raw, no data:
    // prefix — the crop API at /api/exam/[id]/transcribe-mcq/crop
    // returns `cropped.toString("base64")` straight, and the quiz
    // page wraps it with "data:image/jpeg;base64," at render
    // time). One entry per option position. Mutually orthogonal
    // to cleanOpts: some questions have text + image, some have
    // image only.
    //
    // We normalise to a data URL here so embedDataUrlScaled can
    // strip and decode it the same way it handles diagrams.
    const cleanOptImages = isMcq && Array.isArray(q.transcribedOptionImages)
      ? (q.transcribedOptionImages as unknown[]).map((x) => {
          if (typeof x !== "string" || x.length === 0) return null;
          if (x.startsWith("data:image")) return x;
          // Raw base64 — sniff the first 4 bytes to choose the
          // right MIME. The crop API at transcribe-mcq emits JPEG,
          // but other flows (gemini-generated option images via
          // /api/admin/elaborate-mcq, for example) may produce
          // PNG. Wrapping unconditionally with image/jpeg crashed
          // embedJpg on PNG bytes and dropped the option silently.
          const head = Buffer.from(x.slice(0, 12), "base64");
          const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
          const mime = isPng ? "image/png" : "image/jpeg";
          return `data:${mime};base64,${x}`;
        })
      : [];
    const optionCount = Math.max(cleanOpts.length, cleanOptImages.length);

    // Question label
    const label = sanitizeForWinAnsi(`Q${q.questionNum}${marks > 1 ? `   (${marks} marks)` : marks === 1 ? `   (1 mark)` : ""}`);
    const labelH = LINE_PT * 1.5;

    // Keep-together: estimate the height of "stem + first writing
    // area" so the question text doesn't land on page N with the
    // answer box orphaned on page N+1. If the current page can't
    // fit that block but a fresh one could, start a new page now.
    // Note: per-subpart diagrams are NOT measured (they're data
    // URLs and embedding twice is expensive) — we use a small
    // allowance instead. The flow-break logic later still handles
    // overruns for very tall questions.
    const stemLineCount = q.transcribedStem
      ? wrapLines(q.transcribedStem, helv, 11, CONTENT_W).length
      : 0;
    const diagramAllowance = q.diagramImageData ? 80 : 0;
    let firstAnswerBoxH = 0;
    if (isMcq) {
      const optLineCount = cleanOpts.reduce(
        (n, opt) => n + wrapLines(opt, helv, 11, CONTENT_W - 24).length,
        0,
      );
      // When ANY option carries an image, the render loop switches
      // to a 2x2 grid — 2 rows for 4 options. Each row ≈ label
      // (LINE_PT) + image (≤130pt cap) + 6pt gap. Text-only stays
      // 1-up.
      const hasAnyImage = cleanOptImages.some(Boolean);
      const imageOptCount = cleanOptImages.filter(Boolean).length;
      const optionAreaH = hasAnyImage
        ? Math.ceil(optionCount / 2) * (LINE_PT + 130 + 6)
        : optLineCount * LINE_PT + imageOptCount * 130;
      firstAnswerBoxH = optionAreaH + 6 + LINE_PT;
    } else if (realSubs.length > 0) {
      const sp0 = realSubs[0];
      const m0 = String(sp0.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
      const sp0Marks = m0 ? parseInt(m0[1], 10) : marks / realSubs.length;
      const sp0TextH = wrapLines(`(${sp0.label}) ${sp0.text}`, helv, 11, CONTENT_W).length * LINE_PT;
      const sp0LineGap = isScience ? SCI_LINE_GAP : LINE_PT;
      const sp0WriteH = isMath
        ? Math.max(LINE_PT * 3, sp0Marks * A4_H * 0.085)
        : Math.max(sp0LineGap * 2, sp0Marks * 2 * sp0LineGap);
      firstAnswerBoxH = sp0TextH + sp0WriteH;
    } else {
      const singleLineGap = isScience ? SCI_LINE_GAP : LINE_PT;
      firstAnswerBoxH = isMath
        ? Math.max(LINE_PT * 4, marks * A4_H * 0.10)
        : Math.max(singleLineGap * 2, marks * 2 * singleLineGap);
    }
    const keepTogetherH = labelH + stemLineCount * LINE_PT + diagramAllowance + firstAnswerBoxH + 12;
    const atTopOfPage = yCursor >= A4_H - MARGIN - 18 - 1;
    if (!atTopOfPage && yCursor - keepTogetherH < MARGIN) newPage();
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
      // Two layout modes:
      //   - hasAnyImage: 2×2 grid (matches the in-app quiz UI). Two
      //     image options side-by-side per row, saves vertical space
      //     and avoids one-image-per-page on tall diagrams.
      //   - text-only: 1-up list, one option per line.
      const hasAnyImage = cleanOptImages.some(Boolean);
      if (hasAnyImage) {
        // ── 2-column image-option grid ──
        // Capped at ~40% of CONTENT_W per image (vs the old 45%)
        // because (a) some math options have tall portrait diagrams
        // whose scaled height pushed the row past the page bottom,
        // dropping them silently, and (b) thumbnails this size are
        // legible enough for a student to circle without dominating
        // the question.
        const colGap = 16;
        const colW = (CONTENT_W - colGap) / 2;
        const labelIndent = 16;
        const imgTargetW = Math.min(colW - labelIndent, CONTENT_W * 0.40);
        // Hard cap on rendered height — taller diagrams shrink
        // uniformly so we never blow past the page in a row.
        const imgMaxH = 130;
        // Pre-embed all images so we can lay them out with
        // matching row heights. PDFImage + intrinsic embed
        // dimensions tracked alongside; final rendered width /
        // height are clamped at draw time.
        type EmbeddedOpt = { embed: PDFImage; w: number; h: number } | null;
        const embeds: EmbeddedOpt[] = [];
        for (let oi = 0; oi < optionCount; oi++) {
          const optImg = cleanOptImages[oi] ?? null;
          if (!optImg) { embeds.push(null); continue; }
          try {
            const r = await embedDataUrlScaled(doc, optImg, imgTargetW);
            let w = imgTargetW;
            let h = r.height;
            if (h > imgMaxH) {
              const ratio = imgMaxH / h;
              w = w * ratio;
              h = imgMaxH;
            }
            embeds.push({ embed: r.embed, w, h });
          } catch (err) {
            console.warn(`[printable] option image embed failed for Q${q.questionNum} opt ${oi + 1}:`, err);
            embeds.push(null);
          }
        }
        for (let row = 0; row < Math.ceil(optionCount / 2); row++) {
          const leftIdx = row * 2;
          const rightIdx = row * 2 + 1;
          const leftText = cleanOpts[leftIdx] ?? "";
          const rightText = cleanOpts[rightIdx] ?? "";
          const leftImg = embeds[leftIdx];
          const rightImg = embeds[rightIdx];
          // Row height = label + max(image, text-only-line)
          const leftH = leftImg ? leftImg.h : (leftText ? LINE_PT : 0);
          const rightH = rightImg ? rightImg.h : (rightText ? LINE_PT : 0);
          const rowH = LINE_PT + Math.max(leftH, rightH) + 6;
          if (yCursor - rowH < MARGIN) newPage();
          // Labels (and any text alongside) on a shared baseline.
          if (leftIdx < optionCount) {
            const labelLine = `(${leftIdx + 1})` + (leftText ? `  ${leftText}` : "");
            page.drawText(labelLine, { x: MARGIN, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
          }
          if (rightIdx < optionCount) {
            const labelLine = `(${rightIdx + 1})` + (rightText ? `  ${rightText}` : "");
            page.drawText(labelLine, { x: MARGIN + colW + colGap, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
          }
          yCursor -= LINE_PT;
          // Images on the row below — indent so they align with
          // their wrapped-text counterpart for mixed options.
          if (leftImg) {
            page.drawImage(leftImg.embed, { x: MARGIN + labelIndent, y: yCursor - leftImg.h, width: leftImg.w, height: leftImg.h });
          }
          if (rightImg) {
            page.drawImage(rightImg.embed, { x: MARGIN + colW + colGap + labelIndent, y: yCursor - rightImg.h, width: rightImg.w, height: rightImg.h });
          }
          yCursor -= Math.max(leftH, rightH) + 6;
        }
      } else {
        // ── 1-up text-only list ──
        for (let oi = 0; oi < optionCount; oi++) {
          const optText = cleanOpts[oi] ?? "";
          const labelLine = `(${oi + 1})` + (optText ? `  ${optText}` : "");
          const optLines = wrapLines(labelLine, helv, 11, CONTENT_W - 24);
          for (let li = 0; li < optLines.length; li++) {
            if (yCursor - LINE_PT < MARGIN) newPage();
            const x = MARGIN + (li === 0 ? 0 : 24);
            page.drawText(optLines[li], { x, y: yCursor - 11, size: 11, font: helv, color: rgb(0, 0, 0) });
            yCursor -= LINE_PT;
          }
        }
      }
      // Single short answer line for MCQ, aligned to the bottom-right
      // of the question's right margin so the line sits where a
      // student naturally writes a single-letter / single-digit
      // answer.
      yCursor -= 6;
      // If the Answer line itself can't fit on the current page,
      // break first. Without this the line is drawn off the
      // bottom and the saved bounds point at a y outside the
      // page — but more importantly the printed Answer line and
      // the saved pageIndex would disagree about which page it
      // sits on.
      if (yCursor - LINE_PT < MARGIN) newPage();
      const ansY = yCursor - 11;
      const ansBoxStartY = yCursor;
      // Capture which PDF page this Answer line lands on. Used
      // below for printableBounds. The bug was using qStartPage
      // (where the question LABEL was drawn) — if Q9's options
      // and image push the Answer line onto the next page, the
      // y-percentages refer to that next page but pageIndex
      // still pointed at the old one, so the marker cropped Q8's
      // answer area instead.
      const ansBoxPage = pageIndex;
      const ansLabel = "Answer:";
      const ansLabelW = helvBold.widthOfTextAtSize(ansLabel, 11);
      const ansLineW = 120;
      const ansGap = 8;
      const ansLineEndX = MARGIN + CONTENT_W;
      const ansLineStartX = ansLineEndX - ansLineW;
      const ansLabelX = ansLineStartX - ansGap - ansLabelW;
      page.drawText(ansLabel, { x: ansLabelX, y: ansY, size: 11, font: helvBold, color: rgb(0, 0, 0) });
      page.drawLine({ start: { x: ansLineStartX, y: ansY - 2 }, end: { x: ansLineEndX, y: ansY - 2 }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });
      yCursor -= LINE_PT;
      const ansBoxEndY = yCursor;
      boundsByQ.set(q.id, {
        pageIndex: ansBoxPage,
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
        const lineGap = isScience ? SCI_LINE_GAP : LINE_PT;
        const writeH = isMath
          ? Math.max(LINE_PT * 3, subMarks * A4_H * 0.085)
          : Math.max(lineGap * 2, subMarks * 2 * lineGap);
        if (yCursor - writeH < MARGIN) newPage();
        const writeStartY = yCursor;
        const writeStartPage = pageIndex;
        if (isMath) {
          page.drawRectangle({ x: MARGIN, y: yCursor - writeH, width: CONTENT_W, height: writeH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.6 });
          drawMathAnsLine(page, helv, yCursor - writeH);
        } else {
          const linesN = Math.max(2, Math.round(subMarks * 2));
          for (let i = 0; i < linesN; i++) {
            const yLine = yCursor - (i + 1) * lineGap;
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
      const lineGap = isScience ? SCI_LINE_GAP : LINE_PT;
      const writeH = isMath
        ? Math.max(LINE_PT * 4, marks * A4_H * 0.10)
        : Math.max(lineGap * 2, marks * 2 * lineGap);
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
        drawMathAnsLine(page, helv, yCursor - writeH);
      } else {
        const linesN = Math.max(2, Math.round(marks * 2));
        for (let i = 0; i < linesN; i++) {
          const yLine = yCursor - (i + 1) * lineGap;
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

    // Two blank lines between questions for breathing room.
    yCursor -= LINE_PT * 2;
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
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function isMcqQuestion(q: { transcribedOptions?: unknown; transcribedOptionImages?: unknown; answer?: string | null }): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length >= 2) return true;
  // Image-only options: e.g. pictogram MCQs where the answer
  // choices are diagrams rather than text. Treat 2+ image entries
  // the same as 2+ text entries.
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.filter(Boolean).length >= 2) return true;
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

// Stamp an "Ans: ___" line tucked into the bottom-right of an OEQ
// math working box so students always have a single clear spot for
// their final answer regardless of where their working ends up in
// the box. `boxBottomY` is the box's bottom edge in pdf-lib
// coordinates (origin bottom-left).
function drawMathAnsLine(page: PDFPage, font: PDFFont, boxBottomY: number) {
  const label = "Ans:";
  const size = 10;
  const labelW = font.widthOfTextAtSize(label, size);
  const lineW = 100;
  const gap = 6;
  const insetX = 10; // pad from the box's right edge
  const insetY = 10; // pad from the box's bottom edge
  const y = boxBottomY + insetY;
  const lineEndX = MARGIN + CONTENT_W - insetX;
  const lineStartX = lineEndX - lineW;
  const labelX = lineStartX - gap - labelW;
  page.drawText(label, { x: labelX, y, size, font, color: rgb(0.35, 0.35, 0.35) });
  page.drawLine({
    start: { x: lineStartX, y: y - 2 },
    end: { x: lineEndX, y: y - 2 },
    thickness: 0.6,
    color: rgb(0.5, 0.5, 0.5),
  });
}

// Bottom-centre page number. Cover prints as "1" so a parent can
// flip through their scanned images and check that page_0.jpg
// matches "1", page_1.jpg matches "2", etc. Pure visual aid for
// the scan-back flow — the marker doesn't read this.
function drawPageNumber(page: PDFPage, font: PDFFont, num: number) {
  const text = String(num);
  const size = 9;
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (A4_W - w) / 2,
    y: 22,
    size,
    font,
    color: rgb(0.5, 0.5, 0.5),
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

  // ── Submit-via-app banner: bold boxed notice at the very top ──
  // Tells parents to scan + submit inside the app rather than
  // emailing, and reminds students to write in blue ink so the
  // scan-back marker can distinguish their writing from the
  // printed text. Centred, full-width box at the page top.
  const noticeParagraphs = [
    "Use the App's scan function to submit (mobile only). Scan every page.",
    "Please write all answers in blue ink.",
  ];
  const noticeSize = 11;
  const noticeLines = noticeParagraphs.flatMap(p => wrapLines(p, bold, noticeSize, CONTENT_W - 24));
  const noticeLineH = noticeSize + 4;
  const noticePadY = 9;
  const noticeBoxH = noticeLines.length * noticeLineH + noticePadY * 2;
  const noticeBoxY = A4_H - MARGIN - noticeBoxH;
  page.drawRectangle({
    x: MARGIN,
    y: noticeBoxY,
    width: CONTENT_W,
    height: noticeBoxH,
    color: rgb(1, 0.95, 0.78),
    borderColor: rgb(0, 0.12, 0.25),
    borderWidth: 1.2,
  });
  let ny0 = noticeBoxY + noticeBoxH - noticePadY - noticeSize;
  for (const line of noticeLines) {
    const lw = bold.widthOfTextAtSize(line, noticeSize);
    page.drawText(line, { x: (A4_W - lw) / 2, y: ny0, size: noticeSize, font: bold, color: rgb(0, 0.12, 0.25) });
    ny0 -= noticeLineH;
  }

  // ── Brand block: owl logo + wordmark, centred ─────────────────
  // Logo sized so the owl + wordmark together feel "front and
  // centre" but don't crowd out the title underneath.
  const logoSize = 110;
  const wordmarkH = 36;
  // Anchor moved down to clear the new top notice.
  let y = noticeBoxY - 20;
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
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  // Sniff actual binary header rather than trusting the data URL
  // MIME — the quiz UI hardcodes "image/jpeg" for all option
  // images regardless of what the upstream API actually returned,
  // so the prefix can lie. PNG: 89 50 4E 47. JPEG: FF D8 FF.
  const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  let embed: Awaited<ReturnType<typeof doc.embedJpg>> | null = null;
  // First try pdf-lib's native embed for the sniffed format.
  // pdf-lib is strict about JPEG structure (requires APP markers
  // after SOI, valid SOF, etc.), so a "FF D8 FF ..." prefix isn't
  // sufficient for embedJpg to succeed on a corrupt/odd JPEG.
  try {
    if (isPng) embed = await doc.embedPng(bytes);
    else if (isJpg) embed = await doc.embedJpg(bytes);
  } catch {
    // Fall through to the sharp transcode below.
    embed = null;
  }
  if (!embed) {
    // Last resort: transcode through sharp. Handles unknown
    // formats (GIF/WEBP/BMP/SVG) AND rescues JPEGs that pdf-lib
    // rejects for structural quirks — sharp re-encodes them
    // cleanly to PNG that pdf-lib will always accept.
    const sharp = (await import("sharp")).default;
    const png = await sharp(bytes).png().toBuffer();
    embed = await doc.embedPng(png);
  }
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
