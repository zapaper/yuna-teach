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
  xPctEnd: number;     // 0-100, relative to the CROPPED region
  status: "correct" | "partial" | "wrong" | "blank";
  note?: string;
};

async function classifyQuestion(
  regionJpeg: Buffer,
  q: { id: string; questionNum: string; answer: string | null; marksAwarded: number | null; marksAvailable: number | null; markingNotes: string | null },
): Promise<SubpartMark[]> {
  const ai = getAI();
  const prompt = `You are placing red-pen marks on a primary-school exam paper that has already been graded. The attached image is the cropped region for ONE question on the student's scanned page. Top of the image = 0%, bottom = 100%; left = 0%, right = 100%.

QUESTION CONTEXT:
- Question number: ${q.questionNum}
- Expected answer: ${q.answer ?? "(none provided)"}
- Marks awarded: ${q.marksAwarded ?? 0} of ${q.marksAvailable ?? 0}
- Marking notes from AI marker: ${q.markingNotes ?? "(no notes)"}

For EACH subpart in the question (e.g. "(a)", "(b)", "(c)") — or, if there are no subparts, a single entry — output:
1. "label": the subpart letter without parentheses (e.g. "a"), or "" if there are no subparts
2. "yPctEnd": Y position in the cropped image (0-100) just BELOW where the student's handwritten answer for THIS subpart ends. If the subpart is blank, use the Y of the empty answer space.
3. "xPctEnd": X position (0-100) just to the RIGHT of the student's last word for that subpart. If they wrote to the right margin, use 95-100.
4. "status": one of "correct", "partial", "wrong", "blank". Use the marking notes to decide per-subpart status — the notes typically call out which subparts lost marks (e.g. "(b) missing fertilisation"). If notes don't break it down, infer from context (e.g. award fully if marks=full).
5. "note": a 3-7 word teacher shorthand explaining the deduction, ONLY if status is partial / wrong / blank. Examples: "missing 'fertilisation'", "no working shown", "wrong unit". Omit for "correct".

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
    const arr = JSON.parse(raw) as SubpartMark[];
    const cleaned: SubpartMark[] = [];
    for (const m of arr) {
      if (typeof m.yPctEnd !== "number" || typeof m.xPctEnd !== "number") continue;
      const status = (m.status ?? "wrong") as SubpartMark["status"];
      cleaned.push({
        label: String(m.label ?? "").trim(),
        yPctEnd: clamp(m.yPctEnd, 0, 100),
        xPctEnd: clamp(m.xPctEnd, 0, 100),
        status,
        note: m.note ? String(m.note).trim().slice(0, 60) : undefined,
      });
    }
    if (cleaned.length === 0) {
      cleaned.push({ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), note: q.markingNotes?.slice(0, 50) });
    }
    return cleaned;
  } catch (err) {
    console.error(`[export-marked] classifyQuestion Q${q.questionNum} failed:`, err);
    return [{ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q), note: q.markingNotes?.slice(0, 50) }];
  }
}

function fallbackStatus(q: { marksAwarded: number | null; marksAvailable: number | null }): SubpartMark["status"] {
  const a = q.marksAwarded ?? 0;
  const v = q.marksAvailable ?? 0;
  if (v <= 0) return "blank";
  if (a >= v) return "correct";
  if (a === 0) return "wrong";
  return "partial";
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
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
      id: true, title: true, pageCount: true, metadata: true,
      sourceExamId: true, assignedToId: true, userId: true,
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

  // For each question on each scanned page: crop the question's region
  // out of the page JPG with sharp, send to Gemini for per-subpart Y/X
  // positions + status, and remember those marks for stamping.
  type PerQuestionMarks = { qId: string; pageRegion: { topPx: number; leftPx: number; widthPx: number; heightPx: number }; marks: SubpartMark[] };
  const allMarks: { pageIdx: number; perQ: PerQuestionMarks[] }[] = [];

  for (let i = 0; i < pageFiles.length; i++) {
    const jpgPath = path.join(subDir, pageFiles[i]);
    const jpgBytes = await fs.readFile(jpgPath);
    const meta = await sharp(jpgBytes).metadata();
    const Wpx = meta.width ?? 0;
    const Hpx = meta.height ?? 0;
    const qs = bySubPage.get(i) ?? [];
    if (qs.length === 0 || Wpx === 0 || Hpx === 0) {
      allMarks.push({ pageIdx: i, perQ: [] });
      continue;
    }
    // Crop each question's region in parallel, then classify in parallel.
    const perQ = await Promise.all(qs.map(async (q) => {
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
        return { qId: q.id, pageRegion: { topPx, leftPx: 0, widthPx: Wpx, heightPx }, marks: [{ label: "", yPctEnd: 95, xPctEnd: 95, status: fallbackStatus(q) }] };
      }
      const marks = await classifyQuestion(regionBuf, q);
      return { qId: q.id, pageRegion: { topPx, leftPx: 0, widthPx: Wpx, heightPx }, marks };
    }));
    allMarks.push({ pageIdx: i, perQ });
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

    for (const q of qs) {
      const entry = perQ.find(e => e.qId === q.id);
      if (!entry) continue;
      const totalAwarded = q.marksAwarded ?? 0;
      const totalAvail = q.marksAvailable ?? 0;
      const isMcq = entry.marks.length === 1 && entry.marks[0].label === "" && totalAvail > 0; // MCQs come back as a single empty-label entry, fine

      for (const m of entry.marks) {
        // Region coords → page coords (image y is top-down, PDF y is bottom-up).
        const regionTopPx = entry.pageRegion.topPx;
        const regionH = entry.pageRegion.heightPx;
        const regionW = entry.pageRegion.widthPx;
        const yPx = regionTopPx + (m.yPctEnd / 100) * regionH;
        const xPx = (m.xPctEnd / 100) * regionW;
        // Clamp the mark x so it never strays into the right margin past
        // the page edge or so far left it overlaps the writing.
        const markX = Math.min(pageW - markSize * 0.6, Math.max(xPx + markSize * 0.4, pageW * 0.15));
        const markY = pageH - yPx - markSize * 0.2; // small lift so it sits just above the baseline

        const status = m.status;
        if (status === "blank") continue;

        if (status === "correct") {
          drawTick(page, markX, markY, markSize, RED);
        } else if (status === "wrong") {
          drawCross(page, markX, markY, markSize, RED);
        } else if (status === "partial") {
          drawTick(page, markX - markSize * 0.55, markY, markSize, RED);
          drawCross(page, markX + markSize * 0.05, markY, markSize, RED);
        }

        // Caveat note for non-correct subparts. Sits to the LEFT of the
        // mark on the same line, right-aligned so it never overlaps.
        if (status !== "correct" && m.note) {
          const note = m.note;
          const noteW = handFont.widthOfTextAtSize(note, noteSize);
          const maxW = Math.max(60, markX - markSize * 1.5);
          const finalText = noteW > maxW ? note.slice(0, Math.max(3, Math.floor(note.length * (maxW / noteW)) - 1)) + "…" : note;
          const finalW = handFont.widthOfTextAtSize(finalText, noteSize);
          page.drawText(finalText, {
            x: markX - markSize - finalW - 2,
            y: markY - noteSize * 0.1,
            size: noteSize,
            font: handFont,
            color: RED,
          });
        }
      }

      // For partial-credit OEQ, also stamp a small "N/M" chip near the
      // FIRST mark so the parent sees the overall score at a glance.
      // (For MCQ where there's only one subpart this duplicates the
      // status, but it's still useful as a numeric anchor.)
      if (totalAvail > 0 && totalAwarded < totalAvail && entry.marks.length > 0) {
        const first = entry.marks[0];
        const yPx = entry.pageRegion.topPx + (first.yPctEnd / 100) * entry.pageRegion.heightPx;
        const chipY = pageH - yPx + markSize * 0.3;
        const chip = `${totalAwarded}/${totalAvail}`;
        const chipSize = Math.round(markSize * 0.5);
        page.drawText(chip, {
          x: pageW - 60,
          y: chipY,
          size: chipSize,
          font: helvetica,
          color: RED,
        });
      }
      void isMcq;
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
