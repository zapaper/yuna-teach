import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";

// GET /api/exam/[id]/export-marked?userId=<parent>
//
// Builds a downloadable "red-pen" PDF: the student's scanned pages with
// a tick / cross / partial mark stamped at the bottom-right of each
// question's bounding box, and an AI-summarised one-line reason in
// Caveat (handwriting-style) red ink for anything less than full marks.
//
// One mark per question (not per OEQ subpart) — the marking pipeline
// only emits per-question marks today. Per-subpart breakdown can come
// later if it's useful in practice.

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

// Kalam-Regular is bundled at public/fonts/Kalam-Regular.ttf. We use
// Kalam (not Caveat) because Caveat ships only as a variable-weight
// TTF on Google Fonts; pdf-lib/fontkit reads variable fonts but the
// glyph advance metrics come back wrong, leading to large gaps between
// letters in the rendered PDF. Kalam has a proper static-Regular TTF
// and is visually similar — casual handwriting style.
let _handFontBytes: Buffer | null = null;
async function getHandFontBytes(): Promise<Buffer> {
  if (_handFontBytes) return _handFontBytes;
  const fontPath = path.join(process.cwd(), "public", "fonts", "Kalam-Regular.ttf");
  _handFontBytes = await fs.readFile(fontPath);
  return _handFontBytes;
}

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

// Per-subpart mark placement. Gemini looks at the cropped question
// region and tells us where each subpart's answer ends on the page
// AND whether each subpart was correct/partial/wrong, so we can stamp
// a mark next to each (a)/(b)/(c) instead of one mark for the whole
// question. Coordinates are returned relative to the cropped region.
type SubpartMark = {
  label: string;       // "a", "b", "c" — or "" for no-subpart questions
  yPctEnd: number;     // 0-100, relative to the CROPPED region
  xPctEnd: number;     // 0-100, relative to the CROPPED region (kept for future use)
  status: "correct" | "wrong" | "blank";
  marksLost: number;   // marks deducted on this subpart (0 if correct/blank)
  note?: string;
};

async function classifyQuestion(
  regionJpeg: Buffer,
  q: { id: string; questionNum: string; answer: string | null; marksAwarded: number | null; marksAvailable: number | null; markingNotes: string | null },
  subject: string,
): Promise<SubpartMark[]> {
  const ai = getAI();
  const isMath = subject.toLowerCase().includes("math");
  const prompt = `You are placing red-pen marks on a primary-school exam paper that has already been graded. The attached image is the cropped region for ONE question on the student's scanned page. Top of the image = 0%, bottom = 100%; left = 0%, right = 100%.

SUBJECT: ${subject || "(unknown)"}

QUESTION CONTEXT:
- Question number: ${q.questionNum}
- Expected answer: ${q.answer ?? "(none provided)"}
- Marks awarded: ${q.marksAwarded ?? 0} of ${q.marksAvailable ?? 0}
- Marking notes from AI marker: ${q.markingNotes ?? "(no notes)"}

For EACH subpart in the question (e.g. "(a)", "(b)", "(c)") — or, if there are no subparts, a single entry — output:
1. "label": the subpart letter without parentheses (e.g. "a"), or "" if there are no subparts.
2. "yPctEnd": Y position in the cropped image (0-100) just BELOW where the student's handwritten answer for THIS subpart ends. If the subpart is blank, use the Y of the empty answer space.
3. "xPctEnd": X position (0-100) just to the RIGHT of the student's last word for that subpart. If they wrote to the right margin, use 95-100.
4. "status": EXACTLY ONE of "correct" (full marks for this subpart), "wrong" (any marks lost — including partial credit), or "blank" (student wrote nothing). Do NOT output "partial" — partial credit counts as "wrong" for the purposes of the visual mark.
5. "marksLost": the number of marks deducted on THIS subpart. 0 if status is "correct" or "blank". For wrong subparts, estimate based on the marking notes — if notes say "(b) lost 1 mark" use 1; if the question is 1-mark and the subpart is wrong, use 1; if the question carries 2 marks and the student got partial credit, often 1; if uncertain, default to 1.
6. "note": a teacher's red-pen comment, ONLY if status is "wrong" or "blank". The marking notes above are already pithy — preserve their substance, don't over-condense. There is plenty of room on the printed paper for a useful comment.${isMath ? `

   THIS QUESTION IS MATH. The note should pinpoint the calculation error and show the correct step. Use a multi-line format:
   - Line 1: which step is wrong (e.g. "Wrong: 24 ÷ 3 = 9", "Forgot to convert m to cm")
   - Line 2: the correct step or value (e.g. "Should be: 24 ÷ 3 = 8", "100 cm = 1 m, so 250 cm = 2.5 m")
   - Add a third line only if needed for the final answer.
   Use ' / ' inside the note string to indicate line breaks; the renderer will split them.
   Examples:
     - "Wrong: 24 ÷ 3 = 9 / Should be: 24 ÷ 3 = 8 / Final answer = 8 cm"
     - "Missed unit conversion / 250 cm = 2.5 m / Total = 5.5 m"
     - "Used wrong formula / Area of triangle = ½ × b × h / = ½ × 6 × 4 = 12 cm²"
   Cap at ~25 words across all lines.` : `

   For Science / English / other subjects, write a single-line comment (use a space or ' — ' to join clauses, NOT ' / '). Style:
   - Start with a capital letter.
   - Quote specific keywords, formulas, or values in single quotes.
   - Use natural connectors ("and", "or", commas) — not raw lists.
   - Examples (good):
     - "Missing keywords 'different populations' and 'habitat'"
     - "Did not name the process 'fertilisation'"
     - "Wrong unit — should be 'cm', not 'm'"
     - "Diagram missing the arrow showing direction of force"
   - Cap length at ~15 words. Better to omit detail than to be cryptic.`}
   - Omit entirely for "correct" subparts.

OUTPUT: a JSON array, one entry per subpart, in order. NO other keys, NO commentary.`;

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: regionJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const raw = resp.text ?? "[]";
    const arr = JSON.parse(raw) as Array<Partial<SubpartMark> & { status?: string; marksLost?: number }>;
    const cleaned: SubpartMark[] = [];
    for (const m of arr) {
      if (typeof m.yPctEnd !== "number" || typeof m.xPctEnd !== "number") continue;
      // Coerce any "partial" the model still emits down to "wrong".
      const rawStatus = String(m.status ?? "wrong").toLowerCase();
      const status: SubpartMark["status"] = rawStatus === "correct" ? "correct"
        : rawStatus === "blank" ? "blank"
        : "wrong";
      cleaned.push({
        label: String(m.label ?? "").trim(),
        yPctEnd: clamp(m.yPctEnd, 0, 100),
        xPctEnd: clamp(m.xPctEnd, 0, 100),
        status,
        marksLost: status === "wrong" ? Math.max(0, Number(m.marksLost ?? 1)) : 0,
        note: m.note ? String(m.note).trim().slice(0, 90) : undefined,
      });
    }
    if (cleaned.length === 0) {
      cleaned.push({ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), marksLost: fallbackLost(q), note: q.markingNotes?.slice(0, 80) });
    }
    return cleaned;
  } catch (err) {
    console.error(`[export-marked] classifyQuestion Q${q.questionNum} failed:`, err);
    return [{ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), marksLost: fallbackLost(q), note: q.markingNotes?.slice(0, 80) }];
  }
}

function fallbackLost(q: { marksAwarded: number | null; marksAvailable: number | null }): number {
  const a = q.marksAwarded ?? 0;
  const v = q.marksAvailable ?? 0;
  return Math.max(0, v - a);
}

function fallbackStatus(q: { marksAwarded: number | null; marksAvailable: number | null }): SubpartMark["status"] {
  const a = q.marksAwarded ?? 0;
  const v = q.marksAvailable ?? 0;
  if (v <= 0) return "blank";
  if (a >= v) return "correct";
  return "wrong"; // partial credit also renders as a single cross
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function formatMarks(n: number): string {
  // 1 → "1", 0.5 → "½", 1.5 → "1½", 2 → "2"
  const whole = Math.floor(n);
  const half = n - whole >= 0.49 && n - whole <= 0.51;
  if (half) return whole === 0 ? "½" : `${whole}½`;
  return String(whole);
}

// Greedy word-wrap a single line of text to fit within maxWidth at the
// given font + size. Returns the original line when it already fits, or
// a list of fragments that each measure under maxWidth. Long single
// words are kept whole — better to overflow slightly than to split mid-
// word and confuse a reader.
function wrapText(
  line: string,
  font: { widthOfTextAtSize: (s: string, sz: number) => number },
  size: number,
  maxWidth: number,
): string[] {
  if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];
  const words = line.split(/\s+/);
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

// Look up the master metadata so we can compute the same submission-
// page-index map the marking pipeline uses (skipping answer/skip pages).
function buildPageMap(paper: { pageCount: number; metadata: unknown; sourceExamId: string | null }, masterMeta: unknown): Map<number, number> {
  // Prefer master metadata (clones don't always carry it forward).
  const meta = (masterMeta ?? paper.metadata ?? null) as { answerPages?: number[]; skipPages?: number[] } | null;
  const hidden = new Set([
    ...(meta?.answerPages ?? []).map(p => p - 1),
    ...(meta?.skipPages ?? []).map(p => p - 1),
  ]);
  const map = new Map<number, number>();
  let submissionIdx = 0;
  for (let i = 0; i < paper.pageCount; i++) {
    if (!hidden.has(i)) {
      map.set(i, submissionIdx);
      submissionIdx++;
    }
  }
  return map;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    return await handle(request, params);
  } catch (err) {
    console.error("[export-marked] FATAL:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Export failed", detail: msg }, { status: 500 });
  }
}

async function handle(
  request: NextRequest,
  params: Promise<{ id: string }>,
) {
  const { id } = await params;
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, pageCount: true, metadata: true, subject: true,
      sourceExamId: true, assignedToId: true, userId: true,
      reviewAnnotations: true,
      questions: {
        select: {
          id: true, questionNum: true, pageIndex: true,
          yStartPct: true, yEndPct: true, answer: true,
          marksAwarded: true, marksAvailable: true, markingNotes: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // Pull master metadata too — clones inherit it but the field on the
  // clone may be stale; the master is the source of truth.
  let masterMeta: unknown = null;
  if (paper.sourceExamId) {
    const master = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { metadata: true },
    });
    masterMeta = master?.metadata ?? null;
  }

  const requester = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, parentLinks: { select: { studentId: true } } } });
  if (!requester) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const isAdmin = requester.name?.toLowerCase() === "admin";
  const isOwner = paper.userId === userId;
  const isLinkedParent = paper.assignedToId
    ? requester.parentLinks.some(l => l.studentId === paper.assignedToId)
    : false;
  if (!isAdmin && !isOwner && !isLinkedParent) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const subDir = path.join(SUBMISSIONS_DIR, paper.id);
  // Discover what JPGs we actually have on disk (not all questions may
  // have a matching scan if the parent's email was incomplete).
  let pageFiles: string[];
  try {
    const all = await fs.readdir(subDir);
    pageFiles = all.filter(f => /^page_\d+\.jpg$/.test(f)).sort((a, b) => {
      const ai = Number(a.match(/page_(\d+)\.jpg$/)![1]);
      const bi = Number(b.match(/page_(\d+)\.jpg$/)![1]);
      return ai - bi;
    });
  } catch {
    return NextResponse.json({ error: "No submission pages found" }, { status: 404 });
  }
  if (pageFiles.length === 0) {
    return NextResponse.json({ error: "No submission pages found" }, { status: 404 });
  }

  // Map master pageIndex → submission page index (matches the marking pipeline).
  const pageMap = buildPageMap(paper, masterMeta);

  // Group questions by their submission-page index for fast lookup
  // when stamping each page.
  const bySubPage = new Map<number, typeof paper.questions>();
  for (const q of paper.questions) {
    const subPage = pageMap.get(q.pageIndex);
    if (subPage === undefined) continue;
    const arr = bySubPage.get(subPage) ?? [];
    arr.push(q);
    bySubPage.set(subPage, arr);
  }

  // Crop and classify EVERY question across EVERY page in parallel.
  // Earlier we walked pages sequentially with Promise.all only inside
  // each page; on a 19-question paper that meant ~5s of latency that
  // could be ~1s with full fan-out. Each Gemini call is independent so
  // there's nothing stopping us launching them all at once.
  type PerQuestionMarks = { qId: string; pageRegion: { topPx: number; leftPx: number; widthPx: number; heightPx: number }; marks: SubpartMark[] };

  // Pre-load every page's bytes + metadata once.
  const pageData = await Promise.all(pageFiles.map(async (file) => {
    const jpgBytes = await fs.readFile(path.join(subDir, file));
    const meta = await sharp(jpgBytes).metadata();
    return { jpgBytes, Wpx: meta.width ?? 0, Hpx: meta.height ?? 0 };
  }));

  // Build a flat list of (pageIdx, question) tuples and classify in parallel.
  const flatJobs: { pageIdx: number; q: typeof paper.questions[number] }[] = [];
  for (let i = 0; i < pageFiles.length; i++) {
    const qs = bySubPage.get(i) ?? [];
    for (const q of qs) flatJobs.push({ pageIdx: i, q });
  }
  console.log(`[export-marked] classifying ${flatJobs.length} questions in parallel`);
  const t0 = Date.now();
  const flatResults = await Promise.all(flatJobs.map(async ({ pageIdx, q }) => {
    const { jpgBytes, Wpx, Hpx } = pageData[pageIdx];
    if (Wpx === 0 || Hpx === 0) {
      return { pageIdx, qId: q.id, pageRegion: { topPx: 0, leftPx: 0, widthPx: 0, heightPx: 0 }, marks: [{ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), marksLost: fallbackLost(q) }] satisfies SubpartMark[] };
    }
    const yStartPct = q.yStartPct ?? 0;
    const yEndPct = q.yEndPct ?? 100;
    const topPx = Math.max(0, Math.floor(Hpx * yStartPct / 100));
    const bottomPx = Math.min(Hpx, Math.ceil(Hpx * yEndPct / 100));
    const heightPx = Math.max(1, bottomPx - topPx);
    let regionBuf: Buffer;
    try {
      regionBuf = await sharp(jpgBytes).extract({ left: 0, top: topPx, width: Wpx, height: heightPx }).jpeg({ quality: 80 }).toBuffer();
    } catch (err) {
      console.error(`[export-marked] crop failed for Q${q.questionNum}:`, err);
      return { pageIdx, qId: q.id, pageRegion: { topPx, leftPx: 0, widthPx: Wpx, heightPx }, marks: [{ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), marksLost: fallbackLost(q) }] satisfies SubpartMark[] };
    }
    const marks = await classifyQuestion(regionBuf, q, paper.subject ?? "");
    return { pageIdx, qId: q.id, pageRegion: { topPx, leftPx: 0, widthPx: Wpx, heightPx }, marks };
  }));
  console.log(`[export-marked] classification done in ${Date.now() - t0}ms`);

  // Re-bucket by page index for the stamping loop.
  const allMarks: { pageIdx: number; perQ: PerQuestionMarks[] }[] = pageFiles.map((_, i) => ({ pageIdx: i, perQ: [] }));
  for (const r of flatResults) {
    allMarks[r.pageIdx].perQ.push({ qId: r.qId, pageRegion: r.pageRegion, marks: r.marks });
  }

  // Build the PDF.
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const handFontBytes = await getHandFontBytes();
  const handFont = await doc.embedFont(handFontBytes);
  const helvetica = await doc.embedFont(StandardFonts.HelveticaBold);
  const RED = rgb(0.85, 0.10, 0.10);

  for (let i = 0; i < pageFiles.length; i++) {
    const jpgPath = path.join(subDir, pageFiles[i]);
    const jpgBytes = await fs.readFile(jpgPath);
    const img = await doc.embedJpg(jpgBytes);
    const pageW = img.width;
    const pageH = img.height;
    const page = doc.addPage([pageW, pageH]);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });

    const qs = bySubPage.get(i) ?? [];
    const perQ = (allMarks.find(p => p.pageIdx === i)?.perQ) ?? [];
    const markSize = Math.max(28, Math.round(pageH * 0.022));
    const noteSize = Math.max(18, Math.round(pageH * 0.014));
    const isScience = (paper.subject ?? "").toLowerCase().includes("science");

    for (const q of qs) {
      const entry = perQ.find(e => e.qId === q.id);
      if (!entry) continue;

      // Detect OEQ via the answer field — MCQ answers are a single
      // letter/digit; anything else (even a one-word OEQ answer)
      // counts as OEQ for layout purposes.
      const answerStr = (q.answer ?? "").trim();
      const isMcq = /^[A-D1-4]$/i.test(answerStr);
      const isOeq = !isMcq;

      // Mark column: 10% from the right edge by default; 15% for
      // Science OEQ (the user wants more breathing room there).
      const rightInsetPct = isScience && isOeq ? 0.15 : 0.10;
      const markRightX = pageW * (1 - rightInsetPct);
      const markX = markRightX - markSize * 0.5;

      for (const m of entry.marks) {
        const regionTopPx = entry.pageRegion.topPx;
        const regionH = entry.pageRegion.heightPx;
        const yPx = regionTopPx + (m.yPctEnd / 100) * regionH;
        const markY = pageH - yPx - markSize * 0.2;

        const status = m.status;
        if (status === "blank") continue;

        if (status === "correct") {
          drawTick(page, markX, markY, markSize, RED);
          continue;
        }

        // status === "wrong" (covers full-wrong AND partial credit)
        drawCross(page, markX, markY, markSize, RED);

        // "-N" deduction badge to the LEFT of the cross, sized close
        // to the cross itself so the deduction is the loudest signal
        // on the page (parent feedback: "-2" was too small to read at
        // a glance).
        const lost = m.marksLost > 0 ? m.marksLost : 1;
        const badge = `-${formatMarks(lost)}`;
        const badgeSize = Math.round(markSize * 0.95);
        const badgeW = helvetica.widthOfTextAtSize(badge, badgeSize);
        page.drawText(badge, {
          x: markX - markSize * 0.5 - badgeW,
          y: markY - badgeSize * 0.05,
          size: badgeSize,
          font: helvetica,
          color: RED,
        });

        // Note in handwriting, right-aligned to the mark column,
        // sitting just below the cross. Math notes use ' / ' as a line
        // break so step-by-step calculations stack vertically; other
        // subjects pass through as a single line.
        if (m.note) {
          const maxW = pageW * 0.32;
          const rawLines = m.note.split(" / ").map(s => s.trim()).filter(Boolean);
          const wrapped: string[] = [];
          for (const line of rawLines) {
            for (const w of wrapText(line, handFont, noteSize, maxW)) wrapped.push(w);
          }
          let yCursor = markY - markSize * 0.6 - noteSize;
          for (const line of wrapped) {
            const lineW = handFont.widthOfTextAtSize(line, noteSize);
            page.drawText(line, {
              x: markRightX - lineW,
              y: yCursor,
              size: noteSize,
              font: handFont,
              color: RED,
            });
            yCursor -= noteSize * 1.25;
          }
        }
      }
    }

    // Parent's red-pen overlay drawn LAST so their handwriting sits on
    // top of the AI marks. Annotations are PNG data URLs keyed
    // 'submission:<pageIdx>'; pdf-lib only embeds raw image bytes, so
    // strip the data: prefix and decode.
    const annotationKey = `submission:${i}`;
    const annotations = (paper.reviewAnnotations as Record<string, string> | null) ?? null;
    const dataUrl = annotations?.[annotationKey];
    if (dataUrl?.startsWith("data:image/png;base64,")) {
      try {
        const pngBytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
        const pngImage = await doc.embedPng(pngBytes);
        page.drawImage(pngImage, { x: 0, y: 0, width: pageW, height: pageH });
      } catch (err) {
        console.error(`[export-marked] failed to embed pen overlay for page ${i}:`, err);
      }
    }
  }

  const out = await doc.save();
  const safeTitle = (paper.title ?? "Exam").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 80) || "Exam";
  const filename = `${safeTitle} (marked).pdf`;
  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Glyph helpers ────────────────────────────────────────────────────

type Page = ReturnType<PDFDocument["addPage"]>;
function drawTick(page: Page, cx: number, cy: number, size: number, color: ReturnType<typeof rgb>) {
  // A simple V-shape: short stroke down-right, long stroke up-right.
  const lw = Math.max(2, size * 0.12);
  page.drawLine({ start: { x: cx - size * 0.35, y: cy + size * 0.05 }, end: { x: cx - size * 0.05, y: cy - size * 0.30 }, thickness: lw, color });
  page.drawLine({ start: { x: cx - size * 0.05, y: cy - size * 0.30 }, end: { x: cx + size * 0.45, y: cy + size * 0.40 }, thickness: lw, color });
}
function drawCross(page: Page, cx: number, cy: number, size: number, color: ReturnType<typeof rgb>) {
  const lw = Math.max(2, size * 0.12);
  page.drawLine({ start: { x: cx - size * 0.30, y: cy + size * 0.30 }, end: { x: cx + size * 0.30, y: cy - size * 0.30 }, thickness: lw, color });
  page.drawLine({ start: { x: cx - size * 0.30, y: cy - size * 0.30 }, end: { x: cx + size * 0.30, y: cy + size * 0.30 }, thickness: lw, color });
}
