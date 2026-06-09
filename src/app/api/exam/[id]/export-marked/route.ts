import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument, PDFFont, rgb, StandardFonts, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isAdmin as isAdminUser } from "@/lib/admin";
import { requireAccessToPaper } from "@/lib/auth-guard";
import { isCompOeqLabel } from "@/lib/english-sections";

// Whether this question is a Comprehension Cloze fill-in-the-blank
// (single-word answer, no subparts). Detected from the syllabusTopic
// label written by the structure-analysis pipeline. Other Cloze types
// (Vocab Cloze MCQ, Grammar Cloze) are NOT included — their answers
// are letters that the MCQ render path already handles cleanly.
function isComprehensionCloze(syllabusTopic: string | null | undefined): boolean {
  if (!syllabusTopic) return false;
  const t = syllabusTopic.toLowerCase();
  return t.includes("comprehension cloze") || t.includes("comp cloze");
}

// Sections where the student's answer box sits in a narrow right-
// margin column (Editing, Grammar Cloze, Comp Cloze). For these we
// want the tick/cross stamped to the LEFT of the answer column so it
// doesn't sit on top of the student's writing. Detected by
// syllabusTopic.
function isRightMarginAnswerSection(syllabusTopic: string | null | undefined): boolean {
  if (!syllabusTopic) return false;
  const t = syllabusTopic.toLowerCase();
  return t.includes("editing")
    || t.includes("grammar cloze")
    || t.includes("comprehension cloze")
    || t.includes("comp cloze");
}

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

// Hand-extracted tick + cross PNGs (public/Marking/tick-*.png and
// cross-*.png). Each stamp picks one at random per question so the
// resulting PDF has natural ink variation, not four identical
// vector glyphs. Loaded once per process.
// tick-05, tick-07, tick-08 dropped — they read as cropped fragments
// rather than confident hand-drawn ticks. Pool stays at 11 variants.
const TICK_FILES = ["tick-01.png","tick-02.png","tick-03.png","tick-04.png","tick-06.png","tick-09.png","tick-10.png","tick-13.png","tick-14.png","tick-15.png","tick-16.png"] as const;
const CROSS_FILES = ["cross-01.png","cross-02.png","cross-03.png","cross-04.png"] as const;
type MarkImageBytes = { bytes: Buffer; widthPx: number; heightPx: number };
let _tickImages: MarkImageBytes[] | null = null;
let _crossImages: MarkImageBytes[] | null = null;
async function loadMarkImages(files: readonly string[]): Promise<MarkImageBytes[]> {
  const out: MarkImageBytes[] = [];
  for (const f of files) {
    const fp = path.join(process.cwd(), "public", "Marking", f);
    const bytes = await fs.readFile(fp);
    const meta = await sharp(bytes).metadata();
    out.push({ bytes, widthPx: meta.width ?? 1, heightPx: meta.height ?? 1 });
  }
  return out;
}
async function getTickImages(): Promise<MarkImageBytes[]> {
  if (!_tickImages) _tickImages = await loadMarkImages(TICK_FILES);
  return _tickImages;
}
async function getCrossImages(): Promise<MarkImageBytes[]> {
  if (!_crossImages) _crossImages = await loadMarkImages(CROSS_FILES);
  return _crossImages;
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
   Cap at ~25 words across all lines.
   PLAIN TEXT ONLY — never use LaTeX. Write fractions as "7/27", mixed numbers as "4 5/6", exponents as "5²" or "5^2", roots as "√16" or "sqrt(16)". The PDF renderer cannot interpret \\frac, \\sqrt, $...$ — those would render as literal source text.` : `

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
    // Trust the marker over the classifier when there's only one mark
    // to stamp (MCQ, vocab cloze, single-answer short answer). The
    // marker has the marking notes, the answer key, and the OCR — the
    // classifier sees only a cropped image and sometimes flips a clean
    // correct answer to "wrong" because the slice overlapped the
    // neighbouring question or the handwriting was misread. For
    // multi-subpart OEQ we still need the AI's per-subpart status
    // because the marker only emits one verdict for the whole row.
    if (cleaned.length === 1) {
      cleaned[0].status = fallbackStatus(q);
      cleaned[0].marksLost = fallbackLost(q);
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

// Strip LaTeX delimiters/commands so a teacher's note like
// "$\\frac{1}{18}$" renders as "1/18" in the PDF instead of as
// the literal source string. Handles the cases the AI tends to
// emit; not a full parser.
function stripLatex(s: string): string {
  return s
    // \frac{a}{b} → a/b
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$1/$2")
    // \sqrt{x} → √x
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "√$1")
    // \times → ×, \div → ÷
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    // ^{n} → ^n
    .replace(/\^\{([^{}]+)\}/g, "^$1")
    // strip surrounding $...$ delimiters
    .replace(/\$([^$]+)\$/g, "$1")
    // collapse stray backslashes
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .trim();
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
  // Caller from session. requireAccessToPaper also returns the
  // paper's userId/assignedToId so we can short-circuit a 2nd
  // lookup below, but the full paper select below needs more
  // fields so we leave it as-is.
  const auth = await requireAccessToPaper(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, pageCount: true, metadata: true, subject: true,
      sourceExamId: true, assignedToId: true, userId: true, paperType: true,
      reviewAnnotations: true,
      assignedTo: { select: { name: true } },
      questions: {
        select: {
          id: true, questionNum: true, pageIndex: true,
          yStartPct: true, yEndPct: true,
          // xEndPct drives the tick/cross placement for sections where
          // each question has an explicit right-edge (Editing /
          // Grammar Cloze / Comp Cloze — populated by the normal-
          // extract pipeline). Without it we fall back to a fixed
          // page inset.
          xStartPct: true, xEndPct: true,
          answer: true,
          // studentAnswer powers the Comp Cloze "accepted as" green
          // note below the tick when the student wrote a different
          // word from the canonical answer key but still got credit.
          studentAnswer: true,
          marksAwarded: true, marksAvailable: true, markingNotes: true,
          syllabusTopic: true,
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

  // Auth was already verified by requireAccessToPaper(id) at the
  // top — caller is admin, paper.userId, paper.assignedToId, or
  // a linked parent. Re-derive isAdmin from auth for the export
  // logic below that gates on it.
  const isAdmin = auth.isAdmin;

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
  const helveticaRegular = await doc.embedFont(StandardFonts.Helvetica);
  const RED = rgb(0.85, 0.10, 0.10);

  // Pre-embed every tick/cross PNG ONCE per document so the per-question
  // stamp can pick randomly without re-embedding.
  type EmbeddedMark = { img: Awaited<ReturnType<typeof doc.embedPng>>; widthPx: number; heightPx: number };
  const tickImageData = await getTickImages();
  const crossImageData = await getCrossImages();
  const embeddedTicks: EmbeddedMark[] = [];
  for (const t of tickImageData) {
    embeddedTicks.push({ img: await doc.embedPng(t.bytes), widthPx: t.widthPx, heightPx: t.heightPx });
  }
  const embeddedCrosses: EmbeddedMark[] = [];
  for (const c of crossImageData) {
    embeddedCrosses.push({ img: await doc.embedPng(c.bytes), widthPx: c.widthPx, heightPx: c.heightPx });
  }
  function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  // Stamp a tick or cross centred on (cx, cy). Each glyph's natural
  // aspect is preserved — height = targetSize, width scales to match.
  function stampMark(page: Page, kind: "tick" | "cross", cx: number, cy: number, targetSize: number) {
    const pool = kind === "tick" ? embeddedTicks : embeddedCrosses;
    if (pool.length === 0) return;
    const pick = pickRandom(pool);
    const aspect = pick.widthPx / pick.heightPx;
    const drawH = targetSize;
    const drawW = drawH * aspect;
    page.drawImage(pick.img, {
      x: cx - drawW / 2,
      y: cy - drawH / 2,
      width: drawW,
      height: drawH,
    });
  }

  // ── Cover page (always first) ───────────────────────────────────
  // Decide whether to show a per-section breakdown by looking at the
  // shape of the paper — if it has MORE THAN ONE syllabusTopic, it's a
  // multi-section exam (PSLE English 2025 has Grammar MCQ + Vocab Cloze
  // + Editing + Comp Cloze + Synthesis + Comp OEQ even though its
  // paperType is "quiz"). Single-section papers (e.g. P6 Grammar MCQ+
  // focused test) just get the grand total + percentage — a one-row
  // breakdown is noise.
  // (paperType-based gating was the old heuristic; topic-shape detection
  // catches multi-section papers regardless of paperType.)
  // Aggregate marks per syllabusTopic. Questions without a topic are
  // bucketed under "Other" so they aren't silently dropped from the
  // grand total.
  type SectionStat = { label: string; awarded: number; available: number; firstOrder: number };
  const sectionMap = new Map<string, SectionStat>();
  let grandAwarded = 0;
  let grandAvailable = 0;
  paper.questions.forEach((q, idx) => {
    const label = q.syllabusTopic ?? "Other";
    const cur = sectionMap.get(label) ?? { label, awarded: 0, available: 0, firstOrder: idx };
    cur.awarded += q.marksAwarded ?? 0;
    cur.available += q.marksAvailable ?? 0;
    sectionMap.set(label, cur);
    grandAwarded += q.marksAwarded ?? 0;
    grandAvailable += q.marksAvailable ?? 0;
  });
  const sectionList = [...sectionMap.values()].sort((a, b) => a.firstOrder - b.firstOrder);
  const pctRaw = grandAvailable > 0 ? (grandAwarded / grandAvailable) * 100 : 0;
  const pct = Math.round(pctRaw);
  const encouragement = pctRaw >= 80
    ? "Great Work!"
    : pctRaw >= 70
    ? "Good Job!"
    : "Keep up the good work!";

  // Size the cover page to roughly the first scanned page so the bundle
  // visually flows together. Falls back to A4 dimensions if the read
  // fails for any reason.
  let coverW = 1240; // A4 @ 150 DPI
  let coverH = 1754;
  try {
    const firstBytes = await fs.readFile(path.join(subDir, pageFiles[0]));
    const firstMeta = await sharp(firstBytes).metadata();
    if (firstMeta.width && firstMeta.height) {
      coverW = firstMeta.width;
      coverH = firstMeta.height;
    }
  } catch { /* keep A4 default */ }
  {
    const coverPage = doc.addPage([coverW, coverH]);
    coverPage.drawRectangle({ x: 0, y: 0, width: coverW, height: coverH, color: rgb(1, 1, 1) });
    const padX = Math.round(coverW * 0.08);
    const titleSize = Math.round(coverH * 0.034);
    const labelSize = Math.round(coverH * 0.018);
    const totalSize = Math.round(coverH * 0.04);
    const encouragementSize = Math.round(coverH * 0.05);
    const NAVY = rgb(0, 0.118, 0.251);
    const DARK = rgb(0.15, 0.15, 0.15);
    const MUTED = rgb(0.45, 0.45, 0.45);

    let cursorY = coverH - Math.round(coverH * 0.10);

    // Title — paper name
    const titleLine = paper.title ?? "Marked Paper";
    coverPage.drawText(titleLine, { x: padX, y: cursorY, size: titleSize, font: helvetica, color: NAVY });
    cursorY -= titleSize * 1.3;

    // Subline — student name + subject
    const studentLine = paper.assignedTo?.name
      ? `${paper.assignedTo.name}${paper.subject ? ` · ${paper.subject}` : ""}`
      : (paper.subject ?? "");
    if (studentLine) {
      coverPage.drawText(studentLine, { x: padX, y: cursorY, size: labelSize, font: helveticaRegular, color: MUTED });
      cursorY -= labelSize * 2.5;
    } else {
      cursorY -= labelSize;
    }

    // Per-section breakdown — shown whenever the paper has more than one
    // distinct syllabusTopic. Captures English papers regardless of
    // paperType while keeping single-skill tests clean.
    if (sectionList.length > 1) {
      const sectionHeaderSize = Math.round(labelSize * 1.15);
      coverPage.drawText("Section breakdown", { x: padX, y: cursorY, size: sectionHeaderSize, font: helvetica, color: NAVY });
      cursorY -= sectionHeaderSize * 1.6;
      const rowH = labelSize * 1.85;
      // Two-column tabular layout: label left-aligned, score right-aligned.
      const colRightX = coverW - padX;
      for (const s of sectionList) {
        const scoreText = `${s.awarded} / ${s.available}`;
        const scoreWidth = helveticaRegular.widthOfTextAtSize(scoreText, labelSize);
        coverPage.drawText(s.label, { x: padX, y: cursorY, size: labelSize, font: helveticaRegular, color: DARK });
        coverPage.drawText(scoreText, { x: colRightX - scoreWidth, y: cursorY, size: labelSize, font: helvetica, color: DARK });
        cursorY -= rowH;
      }
      cursorY -= rowH * 0.5;
    }

    // Total + percentage — always present.
    const totalText = `Total: ${grandAwarded} / ${grandAvailable}    ${pct}%`;
    coverPage.drawText(totalText, { x: padX, y: cursorY, size: totalSize, font: helvetica, color: RED });
    cursorY -= totalSize * 1.6;

    // Encouragement — large + warm.
    coverPage.drawText(encouragement, { x: padX, y: cursorY, size: encouragementSize, font: helvetica, color: NAVY });
  }

  for (let i = 0; i < pageFiles.length; i++) {
    const jpgPath = path.join(subDir, pageFiles[i]);
    const jpgBytes = await fs.readFile(jpgPath);
    const img = await doc.embedJpg(jpgBytes);
    const pageW = img.width;
    const pageH = img.height;
    const page = doc.addPage([pageW, pageH]);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });

    // Pre-compute per-row mean greyscale so the note placer can slide
    // a comment downward into the nearest whitespace band instead of
    // overlapping the student's writing. We sample only the right 60%
    // of the page (where notes get drawn) so a tall ASCII illustration
    // in the question doesn't poison the row mean.
    const { data: pageGray, info: grayInfo } = await sharp(jpgBytes).greyscale().raw().toBuffer({ resolveWithObject: true });
    const grayW = grayInfo.width;
    const grayH = grayInfo.height;
    const sampleStartX = Math.floor(grayW * 0.4);
    const sampleW = grayW - sampleStartX;
    const rowMeans = new Float32Array(grayH);
    for (let y = 0; y < grayH; y++) {
      let sum = 0;
      const rowOff = y * grayW;
      for (let x = 0; x < sampleW; x++) sum += pageGray[rowOff + sampleStartX + x];
      rowMeans[y] = sum / sampleW;
    }
    // A row counts as "whitespace" if its mean is brighter than this.
    // 240 catches near-white scanned paper without misclassifying very
    // light pencil strokes.
    const WS_THRESHOLD = 240;
    // Search both above AND below the mark for a whitespace band tall
    // enough to hold the note (needH consecutive rows brighter than
    // the threshold). Picks whichever direction's band lands closer
    // to the mark. Returns the band's top y AND the distance from
    // the mark — the caller uses the distance to decide whether the
    // note has drifted far enough that a "(b)" label is needed for
    // the reader to tie the comment back to the subpart.
    function findWhitespaceBand(
      markY: number,
      maxSearch: number,
      needH: number,
    ): { y: number; distance: number; direction: "below" | "above" | "fallback" } {
      const startBelow = Math.floor(markY);
      const endBelow = Math.min(grayH, startBelow + maxSearch);
      let belowTop = -1;
      {
        let runStart = -1;
        let run = 0;
        for (let y = startBelow; y < endBelow; y++) {
          if (rowMeans[y] >= WS_THRESHOLD) {
            if (runStart < 0) runStart = y;
            run++;
            if (run >= needH) { belowTop = runStart; break; }
          } else {
            runStart = -1;
            run = 0;
          }
        }
      }

      // Above: walk upward from markY-1. The "bottom" of the band is
      // the first ws row encountered; extend upward until we have
      // needH consecutive ws rows. Band top = the highest y still in
      // the run.
      const stopAbove = Math.max(0, Math.floor(markY) - maxSearch);
      let aboveTop = -1;
      let aboveBottom = -1;
      {
        let run = 0;
        let lastBottom = -1;
        for (let y = Math.floor(markY) - 1; y >= stopAbove; y--) {
          if (rowMeans[y] >= WS_THRESHOLD) {
            if (run === 0) lastBottom = y;
            run++;
            if (run >= needH) { aboveTop = y; aboveBottom = lastBottom; break; }
          } else {
            run = 0;
            lastBottom = -1;
          }
        }
      }

      const belowDist = belowTop >= 0 ? belowTop - markY : Infinity;
      // Distance for above is from mark down to the bottom of the band.
      const aboveDist = aboveBottom >= 0 ? markY - aboveBottom : Infinity;

      if (belowDist === Infinity && aboveDist === Infinity) {
        return { y: Math.floor(markY), distance: 0, direction: "fallback" };
      }
      if (belowDist <= aboveDist) {
        return { y: belowTop, distance: belowDist, direction: "below" };
      }
      // Above: anchor at aboveTop, but bump down so the note SITS at
      // the band's bottom (closest to the mark) — the note block
      // extends from (aboveBottom - needH + 1) down to aboveBottom.
      return { y: Math.max(0, aboveBottom - needH + 1), distance: aboveDist, direction: "above" };
    }

    const qs = bySubPage.get(i) ?? [];
    const perQ = (allMarks.find(p => p.pageIdx === i)?.perQ) ?? [];
    // 2× larger ticks/crosses than before — they need to read as the
    // dominant red mark on the page, not a small accent.
    const markSize = Math.max(56, Math.round(pageH * 0.044));
    // Note font ~50% larger so the handwriting comment sits at a
    // comfortable teacher-paper reading size next to the stamp.
    const noteSize = Math.max(27, Math.round(pageH * 0.021));
    // English OEQ pages (Comp OEQ, Synthesis) have tight handwriting
    // lines AND wordy marker notes — full English answers can run 3-5
    // lines of teacher commentary. Shrink the font hard (~50% of the
    // standard teacher note) so a longer comment still fits in the
    // available band without crowding the student's writing.
    const englishOeqNoteSize = Math.max(14, Math.round(noteSize * 0.5));
    const isScience = (paper.subject ?? "").toLowerCase().includes("science");
    const isEnglish = (paper.subject ?? "").toLowerCase().includes("english");

    // Per-page list of rects already occupied by previously-placed
    // notes — used to slide a new note DOWN if its chosen anchor would
    // overlap an earlier note. Comp Cloze pages (passage above, 8-10
    // single-blank questions below) are the headline case: every
    // question's band-search falls back to the same band and the notes
    // stack on top of each other. Rects are in PDF-y space (origin
    // bottom-left), same as drawText.
    const placedNoteRects: Array<{ x: number; y: number; w: number; h: number }> = [];

    // Pre-compute every tick / cross rect on this page BEFORE we lay out
    // any notes, so a note can slide DOWN past a tick/cross that hasn't
    // been stamped yet. Without this, question N's note can land on top
    // of question N+1's mark (the mark is drawn AFTER the note since the
    // notes loop runs question-by-question and stamps the tick/cross
    // first then the note for that same Q — so a future Q's mark in the
    // same y-band overlaps a previously-placed note).
    type MarkRect = { x: number; y: number; w: number; h: number };
    const pageMarkRects: MarkRect[] = [];
    for (const qq of qs) {
      const e2 = perQ.find(p => p.qId === qq.id);
      if (!e2) continue;
      const aClean = (qq.answer ?? "").replace(/[().]/g, "").trim();
      const isMcqQ = /^[A-D1-4]$/i.test(aClean);
      const isOeqQ = !isMcqQ;
      // Mark X positioning:
      //   - Editing / Grammar Cloze / Comp Cloze with stored xEndPct:
      //     anchor the mark just PAST the question's bounding-box
      //     right edge — that's "the right edge of the boundary box"
      //     the marker is calling out. Each question's box ends at
      //     a different x (Editing/Grammar Cloze boxes are inset from
      //     the page margin), so a fixed page-relative inset doesn't
      //     land at the box edge.
      //   - Same sections WITHOUT xEndPct (paper hasn't been normal-
      //     extracted yet): fall back to 0.22 page inset.
      //   - Science OEQ: 0.15 inset.
      //   - Everything else: 0.10 inset.
      let mX: number;
      if (isRightMarginAnswerSection(qq.syllabusTopic) && qq.xEndPct != null) {
        const boxRightX = pageW * (qq.xEndPct / 100);
        // Centre the mark just past the right edge so the mark's
        // left side begins ~at the edge of the box.
        mX = boxRightX + markSize * 0.4;
      } else {
        const inset = isRightMarginAnswerSection(qq.syllabusTopic) ? 0.22
          : (isOeqQ && (paper.subject ?? "").toLowerCase().includes("science")) ? 0.15
          : 0.10;
        mX = pageW * (1 - inset) - markSize * 0.5;
      }
      for (const mm of e2.marks) {
        if (mm.status === "blank") continue;
        const regionTopPx = e2.pageRegion.topPx;
        const regionH = e2.pageRegion.heightPx;
        const yPx = regionTopPx + (mm.yPctEnd / 100) * regionH;
        const mY = pageH - yPx - markSize * 0.2;
        pageMarkRects.push({
          x: mX - markSize / 2,
          y: mY - markSize / 2,
          w: markSize,
          h: markSize,
        });
      }
    }

    for (const q of qs) {
      const entry = perQ.find(e => e.qId === q.id);
      if (!entry) continue;

      // Detect OEQ via the answer field. Strip parens / periods first
      // so "(4)", "4.", "4" and "(1)" all detect as MCQ. Anything that
      // doesn't reduce to a single A-D / 1-4 character counts as OEQ.
      const answerStr = (q.answer ?? "").trim();
      const cleanAnswer = answerStr.replace(/[().]/g, "").trim();
      const isMcq = /^[A-D1-4]$/i.test(cleanAnswer);
      const isOeq = !isMcq;
      const isCompCloze = isComprehensionCloze(q.syllabusTopic);
      const isCompOeq = isCompOeqLabel(q.syllabusTopic);

      // Mark X positioning — mirrors the pre-compute pass above.
      //   - Editing / Grammar Cloze / Comp Cloze WITH xEndPct: anchor
      //     just past the question's bounding-box right edge.
      //   - Same sections WITHOUT xEndPct: fall back to 0.22 inset.
      //   - Science OEQ: 0.15 inset.
      //   - Everything else: 0.10 inset.
      let markX: number;
      if (isRightMarginAnswerSection(q.syllabusTopic) && q.xEndPct != null) {
        const boxRightX = pageW * (q.xEndPct / 100);
        markX = boxRightX + markSize * 0.4;
      } else {
        const rightInsetPct = isRightMarginAnswerSection(q.syllabusTopic) ? 0.22
          : (isScience && isOeq) ? 0.15
          : 0.10;
        markX = pageW * (1 - rightInsetPct) - markSize * 0.5;
      }
      // Right edge of the mark — note-anchor logic downstream uses this
      // to right-align the marker's comment to the same x as the mark.
      const markRightX = markX + markSize * 0.5;

      for (const m of entry.marks) {
        const regionTopPx = entry.pageRegion.topPx;
        const regionH = entry.pageRegion.heightPx;
        const yPx = regionTopPx + (m.yPctEnd / 100) * regionH;
        const markY = pageH - yPx - markSize * 0.2;

        const status = m.status;
        if (status === "blank") continue;

        if (status === "correct") {
          stampMark(page, "tick", markX, markY, markSize);
          // Comp Cloze "accepted as" note: when the student wrote a
          // different word from the canonical answer key but still
          // earned the mark (synonym / alt spelling), surface the
          // canonical answer + the marker's reasoning in green ink
          // below the tick. Parent can see both why their child
          // got credit and the "model" answer.
          if (isCompCloze) {
            const keyAns = (q.answer ?? "").trim();
            const studentAns = (q.studentAnswer ?? "").trim();
            const norm = (s: string) => s.toLowerCase().replace(/[^\w'-]/g, "").trim();
            const isDifferent =
              keyAns.length > 0 &&
              studentAns.length > 0 &&
              norm(keyAns) !== norm(studentAns);
            if (isDifferent) {
              const GREEN = rgb(0.10, 0.55, 0.25);
              const reason = q.markingNotes ? stripLatex(q.markingNotes).trim() : "";
              // Line 1 always: "Ans: <answer key>"
              // Line 2 always: "'<student>' accepted" (+ ":  <reason>" when present)
              const line1 = `Ans: ${keyAns}`;
              const line2 = reason
                ? `'${studentAns}' accepted: ${reason}`
                : `'${studentAns}' accepted`;
              const noteSizeAcc = Math.max(11, Math.round(markSize * 0.32));
              // Right-align to the tick's right edge so the note hangs
              // under the mark column rather than drifting back over
              // the student's writing.
              const w1 = helveticaRegular.widthOfTextAtSize(line1, noteSizeAcc);
              const w2 = helveticaRegular.widthOfTextAtSize(line2, noteSizeAcc);
              const noteW = Math.max(w1, w2);
              // Cap width so a long marker note doesn't run off the page.
              const maxW = Math.max(120, pageW - markX - 8);
              const lines = noteW <= maxW
                ? [line1, line2]
                : [
                    ...wrapText(line1, helveticaRegular, noteSizeAcc, maxW),
                    ...wrapText(line2, helveticaRegular, noteSizeAcc, maxW),
                  ];
              const noteX = Math.min(markRightX - Math.max(...lines.map(l => helveticaRegular.widthOfTextAtSize(l, noteSizeAcc))), pageW - 8);
              let cursorY = markY - markSize * 0.55;
              for (const ln of lines) {
                page.drawText(ln, {
                  x: Math.max(8, noteX),
                  y: cursorY,
                  size: noteSizeAcc,
                  font: helveticaRegular,
                  color: GREEN,
                });
                cursorY -= noteSizeAcc * 1.2;
              }
            }
          }
          continue;
        }

        // status === "wrong" (covers full-wrong AND partial credit)
        stampMark(page, "cross", markX, markY, markSize);

        if (isMcq) {
          // MCQ: append "(correctAnswer)" right of the cross. For a
          // 1-mark MCQ the answer key IS the comment — skip the -N
          // badge and the long marking note entirely.
          const mcqNote = `(${cleanAnswer})`;
          const mcqNoteSize = Math.round(markSize * 0.7);
          page.drawText(mcqNote, {
            x: markX + markSize * 0.6,
            y: markY - mcqNoteSize * 0.05,
            size: mcqNoteSize,
            font: helvetica,
            color: RED,
          });
          continue;
        }

        // OEQ from here on: -N deduction badge + per-subpart marking
        // note. Badge is 50% smaller than the cross and uses regular
        // Helvetica (not bold) so the cross stays the dominant signal.
        const lost = m.marksLost > 0 ? m.marksLost : 1;
        const badge = `-${formatMarks(lost)}`;
        const badgeSize = Math.round(markSize * 0.475);
        page.drawText(badge, {
          x: markX + markSize * 0.6,
          y: markY - badgeSize * 0.1,
          size: badgeSize,
          font: helveticaRegular,
          color: RED,
        });

        // Pick the note TEXT. Three shapes:
        //   1. Comp Cloze (fill-in-the-blank with a single-word answer)
        //      — the note is the correct answer with the question
        //      number in front, e.g. "55: gentle". The marker's prose
        //      note is overkill on a one-word blank; the parent just
        //      wants the right word.
        //   2. Comp OEQ with subparts (m.label set) — prepend the
        //      subpart label so a note that slides into whitespace
        //      can still be tied back to (a)/(b)/(c).
        //   3. Everything else — strip LaTeX from the AI's note.
        // (1) and (2) are the cases the user called out; (3) is the
        // pre-existing behaviour.
        const rawNote = isCompCloze
          ? `${q.questionNum}: ${cleanAnswer || (q.answer ?? "")}`
          : m.note
          ? stripLatex(m.note)
          : null;
        if (rawNote) {
          // Pick the effective font size: English OEQ uses the shrunken
          // size so notes fit in the cramped row spacing of English
          // writing-pad pages. Math/Science OEQ keeps the original.
          const effNoteSize = (isEnglish && isOeq) ? englishOeqNoteSize : noteSize;
          // Maximum lines we'll let a note wrap to. English Comp OEQ +
          // Synthesis notes are wordy (whole-sentence rewrites + grammar
          // explanations) and historically got truncated at 2 lines — a
          // note that ends "...because the meaning of the sentence is" mid-
          // sentence is worse than no note. Give the English path room to
          // breathe. Math/Science notes stay capped at 2 (their format is
          // ' / '-separated lines and the existing flow already keeps it
          // tight).
          const maxNoteLines = (isEnglish && isOeq) ? 8 : 2;

          const rawLines = (isCompCloze
            ? `${q.questionNum}: ${cleanAnswer || (q.answer ?? "")}`
            : (m.note ? stripLatex(m.note) : "")
          ).split(" / ").map(s => s.trim()).filter(Boolean);

          // Determine the label-prepend decision FIRST, then wrap. The
          // label needs to live on the first line so a long wrapped note
          // still ties back to (a)/(b)/(c).
          const alreadyLabelled = /^\s*\(/.test(rawNote);
          // Provisional band search just to read .distance — used to
          // decide whether to label. Actual placement happens below.
          const provisionalBlockH = Math.ceil(effNoteSize * 1.25 * maxNoteLines);
          const initialBand = findWhitespaceBand(
            yPx + markSize * 0.6,
            Math.ceil(grayH * 0.3),
            provisionalBlockH,
          );
          const TOO_FAR = markSize * 2.5;
          const labelIt = m.label && !alreadyLabelled && !isCompCloze && (isCompOeq || initialBand.distance > TOO_FAR);
          const labelPrefix = labelIt ? `(${m.label}) ` : "";
          // Prepend the label to the first raw line so the wrapper keeps
          // them visually attached.
          if (rawLines.length > 0 && labelPrefix) rawLines[0] = `${labelPrefix}${rawLines[0]}`;

          // Adaptive width: try a tight 55% first so short notes stay
          // compact. If that forces a wrap, give the note 75% so the
          // longer English commentary gets more horizontal room.
          const wrapAt = (maxW: number) => {
            const out: string[] = [];
            for (const line of rawLines) {
              for (const w of wrapText(line, handFont, effNoteSize, maxW)) out.push(w);
            }
            return out;
          };
          let wrapped = wrapAt(pageW * 0.55);
          if (wrapped.length > 1) wrapped = wrapAt(pageW * 0.75);
          // Cap at maxNoteLines BUT never silently truncate mid-thought.
          // If wrapped overflows, drop the cap to add an ellipsis on the
          // final visible line so the parent knows the note continues
          // somewhere (the markingNotes column has the full text).
          let capped = wrapped.slice(0, maxNoteLines);
          if (wrapped.length > capped.length) {
            const last = capped[capped.length - 1] ?? "";
            capped = [
              ...capped.slice(0, -1),
              (last + " …").trimEnd(),
            ];
          }

          // Left-justified: every line starts at the same x. Anchor
          // the block so its longest line ends near the mark column,
          // keeping the comment visually attached to the cross without
          // ever wandering off the right edge.
          const lineWidths = capped.map(l => handFont.widthOfTextAtSize(l, effNoteSize));
          const longestW = lineWidths.reduce((a, b) => Math.max(a, b), 0);
          const noteX = Math.max(pageW * 0.05, markRightX - longestW);

          // Vertical anchor strategy (prefers BELOW the question's
          // yEnd when there is room):
          //   1. Try the strip immediately below regionTopPx+regionH (i.e.
          //      below yEnd) — if the block fits there before running off
          //      the page, use it. This keeps the comment visually next
          //      to the question it belongs to.
          //   2. Otherwise, do the whitespace-band search the way the
          //      math/science path always has.
          //   3. Final fallback: anchor at the BOTTOM of the question's
          //      bounding region (so two crowded questions on one page
          //      get different y positions).
          const lineSpacingPx = effNoteSize * 1.25;
          const blockH = Math.ceil(effNoteSize * 1.25 * capped.length);
          const belowYEnd = regionTopPx + regionH + Math.round(effNoteSize * 0.3);
          const fitsBelowYEnd = belowYEnd + blockH + 4 <= grayH;
          let wsTop: number;
          if (fitsBelowYEnd) {
            wsTop = belowYEnd;
          } else if (initialBand.direction === "fallback") {
            wsTop = Math.min(grayH - blockH - 4, regionTopPx + regionH - blockH - 4);
          } else {
            // Re-search the band with the ACTUAL block height (since
            // capped may be < maxNoteLines for short notes — wider
            // search lets a small note fit a narrow whitespace gap
            // that the provisional search rejected).
            const refined = findWhitespaceBand(
              yPx + markSize * 0.6,
              Math.ceil(grayH * 0.3),
              blockH,
            );
            if (refined.direction === "fallback") {
              wsTop = Math.min(grayH - blockH - 4, regionTopPx + regionH - blockH - 4);
            } else {
              wsTop = refined.y;
            }
          }
          // PDF-y coordinate of the note block's TOP-LEFT corner.
          let pdfTopY = pageH - wsTop - effNoteSize;
          // Slide down past any rect that the proposed note overlaps —
          // both earlier notes AND every tick/cross on this page. The
          // tick/cross list is pre-computed above so we also avoid marks
          // that haven't been stamped yet (a later question's mark could
          // sit right where this question's note wants to go).
          // Bonus: pad the mark rect by a small gutter horizontally so a
          // long note line doesn't END flush against the mark column —
          // the parent still reads "<note text> ✗" cleanly.
          const MARK_GUTTER = Math.round(markSize * 0.2);
          const paddedMarks = pageMarkRects.map(r => ({
            x: r.x - MARK_GUTTER, y: r.y,
            w: r.w + MARK_GUTTER * 2, h: r.h,
          }));
          for (let guard = 0; guard < 12; guard++) {
            const proposed = { x: noteX, y: pdfTopY - blockH, w: longestW, h: blockH };
            const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
              proposed.x < r.x + r.w &&
              proposed.x + proposed.w > r.x &&
              proposed.y < r.y + r.h &&
              proposed.y + proposed.h > r.y;
            const collides = placedNoteRects.some(overlaps) || paddedMarks.some(overlaps);
            if (!collides) break;
            pdfTopY -= blockH + lineSpacingPx * 0.5;
          }

          // First baseline = block top - one font's ascent.
          let yCursor = pdfTopY;
          for (let li = 0; li < capped.length; li++) {
            const line = capped[li];
            drawJitteredText(page, line, {
              x: noteX,
              y: yCursor,
              size: effNoteSize,
              font: handFont,
              color: RED,
            });
            yCursor -= lineSpacingPx;
          }
          placedNoteRects.push({ x: noteX, y: pdfTopY - blockH, w: longestW, h: blockH });
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
  // Filename = "<StudentFirstName> <title> - Marked paper.pdf".
  // First name only (the surname clutters the title bar without adding
  // anything useful when the parent is looking at their own kids), title
  // unmodified, "- Marked paper" suffix so a parent who downloads the
  // un-marked print version and this one side-by-side can tell them
  // apart at a glance.
  const safeTitle = (paper.title ?? "Exam").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 80) || "Exam";
  const fullName = (paper.assignedTo?.name ?? "").replace(/[^a-zA-Z0-9-_ ]/g, "").trim();
  const firstName = fullName.split(/\s+/)[0]?.slice(0, 40) ?? "";
  const filename = firstName
    ? `${firstName} ${safeTitle} - Marked paper.pdf`
    : `${safeTitle} - Marked paper.pdf`;
  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Page type ────────────────────────────────────────────────────────
// stampMark inside handle() takes a Page argument; declared here so the
// reference is in scope. (Vector drawTick/drawCross helpers replaced by
// hand-stamped PNGs from public/Marking/tick-*.png + cross-*.png.)
type Page = ReturnType<PDFDocument["addPage"]>;

// Render text character-by-character with small per-glyph rotation
// and y-offset so the same letter never renders identically. Closer to
// real handwriting than a single straight drawText call. Spaces are
// skipped (no visible jitter on whitespace).
type JitterOpts = {
  x: number;
  y: number;
  size: number;
  font: PDFFont;
  color: ReturnType<typeof rgb>;
};
function drawJitteredText(page: Page, text: string, opts: JitterOpts) {
  let cx = opts.x;
  for (const ch of text) {
    const w = opts.font.widthOfTextAtSize(ch, opts.size);
    if (ch.trim().length === 0) {
      cx += w;
      continue;
    }
    // ±1.4° rotation, ±opts.size*0.04 y-offset (roughly ±0.6pt at
    // noteSize 18). Subtle enough that letters stay readable but
    // perceptibly hand-drawn.
    const rotDeg = (Math.random() - 0.5) * 2.8;
    const dy = (Math.random() - 0.5) * opts.size * 0.08;
    page.drawText(ch, {
      x: cx,
      y: opts.y + dy,
      size: opts.size,
      font: opts.font,
      color: opts.color,
      rotate: degrees(rotDeg),
    });
    cx += w;
  }
}
