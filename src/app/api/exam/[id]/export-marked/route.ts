import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
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

// Caveat-Regular pulled once per cold start and held in module memory.
// ~150KB. We fetch from Google Fonts' GitHub repo (OFL, public,
// commit-stable URLs) because the public CSS API now only serves WOFF2,
// which pdf-lib + fontkit won't embed. The variable-axis URL is the
// fallback in case the static instance is moved.
let _caveatBytes: Buffer | null = null;
const CAVEAT_CANDIDATES = [
  "https://github.com/google/fonts/raw/main/ofl/caveat/static/Caveat-Regular.ttf",
  "https://github.com/google/fonts/raw/main/ofl/caveat/Caveat%5Bwght%5D.ttf",
];
async function getCaveatBytes(): Promise<Buffer> {
  if (_caveatBytes) return _caveatBytes;
  let lastErr: unknown = null;
  for (const url of CAVEAT_CANDIDATES) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) { lastErr = new Error(`${url} → ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      // Sanity: TTF starts with 0x00 0x01 0x00 0x00 (or "OTTO"). Reject
      // anything that looks like HTML / WOFF / a 404 page.
      if (buf.length < 1024 || buf.slice(0, 4).toString("hex") !== "00010000") {
        lastErr = new Error(`${url} did not return a valid TTF (first 4 bytes: ${buf.slice(0, 4).toString("hex")})`);
        continue;
      }
      _caveatBytes = buf;
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Caveat font fetch failed: ${String(lastErr)}`);
}

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

// Compress freeform marking notes into a 3-7 word teacher-style note
// suitable for writing in red ink at the margin. Batched: one Gemini
// call handles every question on the paper at once.
async function summariseNotes(items: { id: string; note: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0) return out;
  const ai = getAI();
  const prompt = `You are summarising a teacher's marking comments into very short red-pen notes for a primary school exam paper. For each item, output a 3-7 word note suitable for writing at the margin of the paper. Use teacher shorthand. Examples: "missing 'fertilisation'", "no working shown", "incorrect formula", "(b) wrong unit". Reply ONLY with a JSON array, one entry per input, in the same order. Each entry: {"id": "<id>", "note": "<short note>"}.

Input:
${JSON.stringify(items)}`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const raw = resp.text ?? "[]";
    const arr = JSON.parse(raw) as { id: string; note: string }[];
    for (const e of arr) {
      if (e.id && e.note) out.set(e.id, String(e.note).trim().slice(0, 60));
    }
  } catch (err) {
    console.error("[export-marked] note summarisation failed:", err);
    // Fall back to truncated raw notes.
    for (const it of items) out.set(it.id, it.note.slice(0, 50));
  }
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
      id: true, title: true, pageCount: true, metadata: true,
      sourceExamId: true, assignedToId: true, userId: true,
      questions: {
        select: {
          id: true, questionNum: true, pageIndex: true,
          yStartPct: true, yEndPct: true,
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

  // Collect partial / wrong notes for AI summarisation.
  const toSummarise: { id: string; note: string }[] = [];
  for (const q of paper.questions) {
    const a = q.marksAwarded ?? 0;
    const v = q.marksAvailable ?? 0;
    if (v <= 0) continue;
    if (a >= v) continue; // correct, no note needed
    const n = (q.markingNotes ?? "").trim();
    if (!n) continue;
    toSummarise.push({ id: q.id, note: n });
  }
  const summaries = await summariseNotes(toSummarise);

  // Build the PDF.
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const caveatBytes = await getCaveatBytes();
  const caveat = await doc.embedFont(caveatBytes);
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
    for (const q of qs) {
      const yStartPct = q.yStartPct ?? 0;
      const yEndPct = q.yEndPct ?? 100;
      // PDF coords have y=0 at the bottom. The image's yStartPct=0 is
      // the TOP of the page. So bottom-right of the question box is at
      // pdfY = pageH - (yEndPct/100)*pageH + small margin.
      const markX = pageW * 0.92;          // 8% in from right edge
      const markY = pageH - (yEndPct / 100) * pageH + pageH * 0.005;
      const a = q.marksAwarded ?? 0;
      const v = q.marksAvailable ?? 0;
      const correct = v > 0 && a >= v;
      const wrong = v > 0 && a === 0;
      const partial = v > 0 && a > 0 && a < v;
      const markSize = Math.max(28, Math.round(pageH * 0.022));

      if (correct) {
        drawTick(page, markX, markY, markSize, RED);
      } else if (wrong) {
        drawCross(page, markX, markY, markSize, RED);
      } else if (partial) {
        drawTick(page, markX - markSize * 0.55, markY, markSize, RED);
        drawCross(page, markX + markSize * 0.05, markY, markSize, RED);
      } else {
        // Unmarked / no marks available — skip.
        continue;
      }

      // Score chip (e.g. "1/2") next to the mark, in Helvetica so it's
      // crisp at small sizes.
      if (v > 0 && !correct) {
        const chip = `${a}/${v}`;
        const chipSize = Math.round(markSize * 0.45);
        page.drawText(chip, {
          x: markX - markSize * 1.2,
          y: markY - markSize * 0.1,
          size: chipSize,
          font: helvetica,
          color: RED,
        });
      }

      if (!correct) {
        const note = summaries.get(q.id);
        if (note) {
          // Caveat sits below the mark, right-aligned to the page edge.
          const noteSize = Math.max(18, Math.round(pageH * 0.014));
          const noteW = caveat.widthOfTextAtSize(note, noteSize);
          const maxW = pageW * 0.30;
          const finalText = noteW > maxW ? note.slice(0, Math.floor(note.length * (maxW / noteW)) - 1) + "…" : note;
          const finalW = caveat.widthOfTextAtSize(finalText, noteSize);
          page.drawText(finalText, {
            x: pageW - finalW - pageW * 0.02,
            y: markY - markSize - noteSize * 0.4,
            size: noteSize,
            font: caveat,
            color: RED,
          });
        }
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
