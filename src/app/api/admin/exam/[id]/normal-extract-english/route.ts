// Per-section "Normal Extract" pipeline for English papers — produces
// per-question bounding boxes (pageIndex / yStartPct / yEndPct /
// xStartPct / xEndPct) so the paper can be rendered as a PDF-format
// quiz instead of the typed quiz-format that English papers fall back
// to today.
//
// Kept SEPARATE from the math/science extraction pipeline:
//   - Admin-gated
//   - English subject only
//   - Driven by metadata.englishSections (already populated by the
//     clean-extract / overall-structure pipeline)
//
// Per-section completion is tracked in metadata.normalExtractEnglish:
//   { bookletA?: true, grammarCloze?: true, editing?: true,
//     compCloze?: true, compOeq?: true, lastRunAt?: string }
//
// Section heuristics:
//   - Booklet A (sequential MCQ stack): per-page Q-number detection,
//     yEndPct = next Q on same page (or 100% if last). Full width.
//   - Grammar Cloze (inline blanks): box around each Q number,
//     yTop ±5%, xLeft ±6%.
//   - Editing (Q number then edited word): yTop ±5%, x = [xLeft, xLeft+15%].
//   - Comp Cloze: same as Grammar Cloze.
//   - Comp OEQ: sequential like Booklet A, full width.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

type SectionType = "booklet-a" | "grammar-cloze" | "editing" | "comp-cloze" | "synthesis" | "comp-oeq";
type SecMeta = { label: string; startIndex: number; endIndex: number; passage?: string };
type NormalExtractState = {
  bookletA?: boolean;
  grammarCloze?: boolean;
  editing?: boolean;
  compCloze?: boolean;
  synthesis?: boolean;
  compOeq?: boolean;
  lastRunAt?: string;
};
type QuestionRow = { id: string; questionNum: string; pageIndex: number | null };
type Detection = { questionNum: string; xPctLeft: number; yPctTop: number };
type QuestionBound = {
  id: string;
  questionNum: string;
  pageIndex: number | null;
  yStartPct: number | null;
  yEndPct: number | null;
  xStartPct: number | null;
  xEndPct: number | null;
  status: "updated" | "not_detected" | "no_page";
};
type RunOutput = {
  updated: number;
  warnings: string[];
  perSection: Array<{ label: string; updated: number }>;
  bounds: QuestionBound[];
};

// Patterns are based on the labels actually used in prod's
// metadata.englishSections (snapshot 2026-06-02). Schools format the
// labels inconsistently — sometimes the MCQ suffix is dropped, and
// "Section A: Grammar and Vocab MCQ" lumps Grammar + Vocab into one.
// We match liberally on the obvious tokens.
const SECTION_LABELS: Record<SectionType, RegExp[]> = {
  "booklet-a": [
    /grammar mcq/i,                  // "Grammar MCQ"
    /grammar and vocab/i,            // "Section A: Grammar and Vocab MCQ"
    /vocabulary mcq/i,               // "Vocabulary MCQ"
    /vocab(?:ulary)? cloze/i,        // "Vocabulary Cloze MCQ", "Section A/B: Vocab Cloze"
    /visual text/i,                  // "Visual Text Comprehension MCQ", "Section B/C: Visual Text"
  ],
  "grammar-cloze": [/grammar cloze/i],
  "editing": [/editing/i],
  "comp-cloze": [/comprehension cloze/i],
  "synthesis": [/synthesis/i, /transformation/i],
  "comp-oeq": [/comprehension open[\s-]?ended/i, /comprehension \(open[\s-]?ended\)/i, /comprehension oeq/i],
};

function sectionMatches(label: string, type: SectionType): boolean {
  return SECTION_LABELS[type].some(re => re.test(label));
}

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// Ask Gemini to find every visible question number on a page and report
// its top-left corner as (xPctLeft, yPctTop). Used by every section
// type — Booklet A and Comp OEQ discard the x value and only use y.
async function findQuestionPositionsOnPage(
  pageBytes: Buffer,
  pageIndex: number,
  expectedQuestionNums: string[],
  sectionHint: string,
  // Explicit override for cloze-inline detection. When set, we honour
  // the caller; when omitted, we fall back to substring-matching the
  // hint (legacy behaviour). The fallback misfired on Booklet A's
  // Vocab Cloze MCQ — that section IS an MCQ list below the passage,
  // not inline blanks — because the hint text contained the substring
  // "Cloze". Caller now passes false for booklet-a explicitly.
  isClozeSectionOverride?: boolean,
): Promise<Detection[]> {
  // Detect whether the expected list contains subpart-style numbers
  // (66a / 66 (a) / etc). When it does, the page likely shows the main
  // number "66." on its own line with "(a)" and "(b)" beneath as
  // separate writing rows — each is a distinct answer location and
  // must be reported as its own entry.
  const expectsSubparts = expectedQuestionNums.some(n => /^\d+\s*[(\s]\s*[a-z]\b|\d+\s*[a-z]$/i.test(n.trim()));
  const subpartGuidance = expectsSubparts ? `

CRITICAL — SUBPARTS: this section contains questions with sub-labels (a), (b), (c). When a question is printed like:
    66.
    (a) _____________
    (b) _____________
…report EACH subpart as its own entry: questionNum "66a" (or "66 (a)") at the y of the "(a)" line, AND questionNum "66b" at the y of the "(b)" line. Do NOT report just "66" alone in that case — the parent number is not a writable answer slot.

Match flexibly against the expected list: "66a" / "66(a)" / "66 (a)" are all the same question. Pick whichever exact form appears in the expected list and use it as your questionNum.` : "";

  // Cloze sections (grammar / comp cloze) have the question number
  // INLINE WITHIN the passage text — e.g. "oysters (46) ______ are
  // important". The generic "NOT a reference inside text" rule below
  // makes Gemini skip these. Override that for cloze sections so it
  // reports every (N) that sits next to a writable blank.
  //
  // Booklet A's Vocab Cloze MCQ does NOT qualify even though its hint
  // mentions "Cloze" — its question numbers live in the MCQ list
  // below the passage, NOT next to the inline blanks. Caller passes
  // isClozeSectionOverride=false in that case.
  const isClozeSection = isClozeSectionOverride !== undefined
    ? isClozeSectionOverride
    : /cloze/i.test(sectionHint);
  const clozeGuidance = isClozeSection ? `

CLOZE INLINE QUESTION NUMBERS: this is a cloze section. Each question number is printed INLINE WITHIN the passage text, in parentheses like "(46)", "(47)", placed IMMEDIATELY BEFORE or AFTER a blank line. Examples:
    "oysters (46) ______________ environmental 'superstars'"
    "She knew (50) ______________ nothing about oysters"
    "the cages out (55) ______________ from the water"
These INLINE (N) markers ARE the question numbers — report each one. The general rule "NOT a reference inside text" does NOT apply here; in a cloze section every (N) inside the passage IS a question marker, and you must report all of them.` : "";

  const prompt = `You are reading page ${pageIndex + 1} of a Singapore PSLE English paper. The section on this page is: ${sectionHint}.

Identify EVERY question number that is the START of a question on this page (a numbered question stem or numbered blank, NOT a page number, NOT a reference inside text).${clozeGuidance}

For each one, report:
- "questionNum": the bare number as it appears (e.g. "1", "12", "21", "66 (a)", "66 (b)")
- "xPctLeft": horizontal position of the LEFT edge of the question number, as a percentage of the page width from the left (0 = far left, 100 = far right)
- "yPctTop": vertical position of the TOP edge of the question number, as a percentage of the page height from the top (0 = very top, 100 = very bottom)

Expected question numbers in this paper: ${expectedQuestionNums.join(", ")}. Match the printed number against this list and IGNORE any number on the page that isn't in the expected list.${subpartGuidance}

Output STRICTLY this JSON shape — no markdown, no commentary:
{
  "questions": [
    { "questionNum": "1", "xPctLeft": 8.0, "yPctTop": 12.5 },
    { "questionNum": "2", "xPctLeft": 8.0, "yPctTop": 22.0 }
  ]
}`;

  const resp = await getAI().models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: pageBytes.toString("base64") } },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });

  const text = resp.text ?? "{}";
  try {
    const parsed = JSON.parse(text) as { questions?: Array<{ questionNum?: unknown; xPctLeft?: unknown; yPctTop?: unknown }> };
    const out: Detection[] = [];
    for (const q of parsed.questions ?? []) {
      const num = String(q.questionNum ?? "").trim();
      const x = Number(q.xPctLeft);
      const y = Number(q.yPctTop);
      if (!num || !Number.isFinite(y)) continue;
      out.push({
        questionNum: num,
        xPctLeft: Number.isFinite(x) ? clampPct(x) : 0,
        yPctTop: clampPct(y),
      });
    }
    return out;
  } catch (err) {
    console.error(`[normal-extract] parse failed for page ${pageIndex}:`, err);
    return [];
  }
}

// Collect detections for every page in the section's page range.
// Uses a CONTIGUOUS range from min(stored pageIndex) to max(stored
// pageIndex) so we don't miss pages where every question's
// pageIndex was tagged wrong by Clean Extract (e.g. all Q6-Q10
// pointing at page 2 when they're really on page 3). An explicit
// pageRange override is honoured when the caller knows better
// (metadata.papers fallback for Booklet A).
async function detectAcrossSectionPages(args: {
  paperId: string;
  sectionQuestionIds: Set<string>;
  allQuestions: QuestionRow[];
  sectionHint: string;
  pageRange?: { start: number; endExclusive: number };
  pageCount?: number;
  // Forwarded into findQuestionPositionsOnPage so callers can override
  // the substring-based cloze detection on a per-section basis.
  isClozeSectionOverride?: boolean;
}): Promise<{ detectionsByPage: Map<number, Detection[]>; warnings: string[] }> {
  const { paperId, sectionQuestionIds, allQuestions, sectionHint, pageRange, pageCount, isClozeSectionOverride } = args;
  const warnings: string[] = [];

  let pagesToScan: number[] = [];
  if (pageRange) {
    for (let i = pageRange.start; i < pageRange.endExclusive; i++) pagesToScan.push(i);
  } else {
    const stored: number[] = [];
    for (const q of allQuestions) {
      if (sectionQuestionIds.has(q.id) && q.pageIndex != null) stored.push(q.pageIndex);
    }
    if (stored.length > 0) {
      let min = Math.min(...stored);
      const max = Math.max(...stored);
      // Cover-page rescue: when EVERY question in this section was
      // tagged with pageIndex=0 (Clean Extract's most common failure
      // mode — assigns the cover when it can't resolve a real page),
      // look back to the question BEFORE this section and use its
      // pageIndex+1 as the floor.
      //
      // Only fires when stored min === 0 to avoid being triggered by
      // a single mis-tagged question elsewhere — e.g. Henry Park's
      // Q27 (grammar cloze) was tagged at p23 while the rest of the
      // section sat at p15, which used to fool the heuristic into
      // bumping the editing section's floor from 16 to 24.
      if (min === 0) {
        const firstSectionOrderIdx = (() => {
          let lo = Infinity;
          for (let i = 0; i < allQuestions.length; i++) {
            if (sectionQuestionIds.has(allQuestions[i].id)) { lo = i; break; }
          }
          return Number.isFinite(lo) ? lo : -1;
        })();
        if (firstSectionOrderIdx > 0) {
          // Walk backwards until we find a question with a non-zero
          // pageIndex. Use that question's page + 1 as the floor.
          for (let i = firstSectionOrderIdx - 1; i >= 0; i--) {
            const priorPg = allQuestions[i].pageIndex;
            if (priorPg != null && priorPg > 0) {
              const newMin = priorPg + 1;
              console.log(`[normal-extract] ${sectionHint}: stored min=0 (cover-tagged); using prior question's pageIndex+1 = ${newMin}`);
              min = newMin;
              break;
            }
          }
        }
      }
      // Forward buffer: scan 6 extra pages beyond the last stored
      // pageIndex. Catches the case where the LAST question of a
      // section (often Comp OEQ tail) was tagged on page N by Clean
      // Extract but actually starts on page N+1 — without the buffer
      // Gemini never sees that page and the detection silently fails.
      //
      // Cap at pageCount-1 so we don't try to read page_18 on an
      // 18-page paper.
      const lookAhead = Math.max(max + 6, min + 8); // ensure at least 8 pages forward from new min
      const upper = pageCount != null ? Math.min(lookAhead, pageCount - 1) : lookAhead;
      for (let i = min; i <= upper; i++) pagesToScan.push(i);
      console.log(`[normal-extract] ${sectionHint}: pageIndex range [${min},${max}] → scanning pages ${pagesToScan.join(",")} (upper cap=${upper}, pageCount=${pageCount ?? "?"})`);
    }
  }

  const detectionsByPage = new Map<number, Detection[]>();
  if (pagesToScan.length === 0) return { detectionsByPage, warnings };

  const expectedNums = [...sectionQuestionIds]
    .map(id => allQuestions.find(q => q.id === id)?.questionNum)
    .filter(Boolean) as string[];

  // Scan pages in parallel. With page-range expansion this can be 10+
  // pages — sequential calls (~8s each) blow past Cloudflare's 100s
  // proxy timeout. Parallel keeps total time bounded by the slowest
  // single Gemini call (~10s).
  console.log(`[normal-extract] ${sectionHint}: expected question numbers = ${expectedNums.join(",")}`);
  const results = await Promise.all(pagesToScan.map(async (pageIdx) => {
    const pagePath = path.join(PAGES_DIR, paperId, `page_${pageIdx}.jpg`);
    let pageBytes: Buffer;
    try {
      pageBytes = await fs.readFile(pagePath);
    } catch {
      console.log(`[normal-extract] page_${pageIdx}.jpg NOT FOUND on disk`);
      return { pageIdx, warning: `Page image not found on disk: page_${pageIdx}.jpg`, detections: null as Detection[] | null };
    }
    const detections = await findQuestionPositionsOnPage(pageBytes, pageIdx, expectedNums, sectionHint, isClozeSectionOverride);
    console.log(`[normal-extract] page ${pageIdx}: detected ${detections.length} question numbers: ${detections.map(d => `Q${d.questionNum}@y${d.yPctTop.toFixed(1)}`).join(", ") || "(none)"}`);
    return { pageIdx, warning: null as string | null, detections };
  }));

  for (const r of results) {
    if (r.warning) warnings.push(r.warning);
    if (r.detections) detectionsByPage.set(r.pageIdx, r.detections);
  }
  // Summary: which expected nums DIDN'T turn up anywhere (normalized).
  const allDetectedNums = new Set<string>();
  for (const dets of detectionsByPage.values()) {
    for (const d of dets) {
      allDetectedNums.add(d.questionNum);
      allDetectedNums.add(normalizeQuestionNum(d.questionNum));
    }
  }
  const missing = expectedNums.filter(n => !allDetectedNums.has(n) && !allDetectedNums.has(normalizeQuestionNum(n)));
  if (missing.length > 0) {
    console.log(`[normal-extract] ${sectionHint}: ${missing.length} expected nums NOT detected on any scanned page: ${missing.join(",")}`);
  }
  return { detectionsByPage, warnings };
}

function collectSectionQuestionIds(sections: SecMeta[], allQuestions: QuestionRow[]): Set<string> {
  const ids = new Set<string>();
  for (const sec of sections) {
    for (let i = sec.startIndex; i <= sec.endIndex && i < allQuestions.length; i++) {
      ids.add(allQuestions[i].id);
    }
  }
  return ids;
}

// Normalize a question number so "69 (a)" / "69(a)" / "69 a" / "69a"
// all map to the same key. Clean Extract stores PSLE subpart numbers
// as "69 (a)" with spaces + parens; Gemini reports them as just "69"
// or "69a" depending on what it sees on the page. Without
// normalization, expected "69 (a)" never matches detected "69a".
function normalizeQuestionNum(num: string): string {
  return num.trim().toLowerCase().replace(/[\s()]+/g, "");
}

// Build a global { questionNum -> { pageIdx, yPctTop, xPctLeft } } map
// from all per-page Gemini detections. Trusts whichever page detected
// the question rather than the question's stored pageIndex — heals
// papers where Clean Extract assigned the wrong page.
//
// Keyed by the NORMALIZED form so detection lookups by either format
// ("69 (a)" or "69a") both hit. flattenDetections also stores each
// detection under its raw key for backward-compat with callers that
// happen to pass the exact same string Gemini returned.
function flattenDetections(detectionsByPage: Map<number, Detection[]>): Map<string, { pageIdx: number; yPctTop: number; xPctLeft: number }> {
  const out = new Map<string, { pageIdx: number; yPctTop: number; xPctLeft: number }>();
  for (const [pageIdx, dets] of detectionsByPage.entries()) {
    for (const d of dets) {
      const norm = normalizeQuestionNum(d.questionNum);
      if (!out.has(norm)) {
        out.set(norm, { pageIdx, yPctTop: d.yPctTop, xPctLeft: d.xPctLeft });
      }
      if (d.questionNum !== norm && !out.has(d.questionNum)) {
        out.set(d.questionNum, { pageIdx, yPctTop: d.yPctTop, xPctLeft: d.xPctLeft });
      }
    }
  }
  return out;
}

// Sequential-numbering extractor used by Booklet A and Comp OEQ.
// yEndPct = next question's yTop on the same page (or 100% if last).
// No x bounds — questions span full page width.
async function extractSequential(args: {
  paperId: string;
  sections: SecMeta[];
  allQuestions: QuestionRow[];
  sectionHint: string;
  pageCount?: number;
  pageRange?: { start: number; endExclusive: number };
  isClozeSectionOverride?: boolean;
}): Promise<RunOutput> {
  const { sections, allQuestions } = args;
  const sectionQuestionIds = collectSectionQuestionIds(sections, allQuestions);

  if (sectionQuestionIds.size === 0) {
    return { updated: 0, warnings: ["No questions found in metadata.englishSections for this section."], perSection: [], bounds: [] };
  }

  const { detectionsByPage, warnings } = await detectAcrossSectionPages({
    paperId: args.paperId,
    sectionQuestionIds,
    allQuestions,
    sectionHint: args.sectionHint,
    pageCount: args.pageCount,
    pageRange: args.pageRange,
    isClozeSectionOverride: args.isClozeSectionOverride,
  });

  if (detectionsByPage.size === 0) {
    warnings.push("No pages with detectable question numbers — has Clean Extract run on this paper?");
    return { updated: 0, warnings, perSection: [], bounds: [] };
  }

  const detByNum = flattenDetections(detectionsByPage);

  let updated = 0;
  const perSection: Array<{ label: string; updated: number }> = [];
  const bounds: QuestionBound[] = [];

  for (const sec of sections) {
    // For yEnd lookup we need the page-local sort: questions in this
    // section that landed on the same page, sorted by yPctTop.
    const sectionQuestions: QuestionRow[] = [];
    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
      sectionQuestions.push(allQuestions[qi]);
    }

    let sectionUpdated = 0;
    for (const q of sectionQuestions) {
      const det = detByNum.get(q.questionNum) ?? detByNum.get(normalizeQuestionNum(q.questionNum));
      if (!det) {
        warnings.push(`Q${q.questionNum} not detected by Gemini on any scanned page.`);
        bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: q.pageIndex, yStartPct: null, yEndPct: null, xStartPct: null, xEndPct: null, status: "not_detected" });
        continue;
      }
      const samePageSorted = sectionQuestions
        .map(qq => {
          const d = detByNum.get(qq.questionNum) ?? detByNum.get(normalizeQuestionNum(qq.questionNum));
          return d && d.pageIdx === det.pageIdx ? { qq, d } : null;
        })
        .filter((x): x is { qq: QuestionRow; d: NonNullable<typeof det> } => x != null)
        .sort((a, b) => a.d.yPctTop - b.d.yPctTop);
      const myIdx = samePageSorted.findIndex(x => x.qq.id === q.id);
      const yStart = det.yPctTop;
      const yEnd = myIdx + 1 < samePageSorted.length ? samePageSorted[myIdx + 1].d.yPctTop : 100;
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { yStartPct: yStart, yEndPct: yEnd, xStartPct: null, xEndPct: null, pageIndex: det.pageIdx },
      });
      sectionUpdated++;
      updated++;
      bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: det.pageIdx, yStartPct: yStart, yEndPct: yEnd, xStartPct: null, xEndPct: null, status: "updated" });
    }
    perSection.push({ label: sec.label, updated: sectionUpdated });
  }

  return { updated, warnings, perSection, bounds };
}

// Anchored-crop extractor used by Grammar Cloze, Editing, Comp Cloze.
// Builds a fixed-size box around each question number using offsets
// supplied per section type.
async function extractAnchoredCrop(args: {
  paperId: string;
  sections: SecMeta[];
  allQuestions: QuestionRow[];
  sectionHint: string;
  xLeftDelta: number;
  xRightDelta: number;
  yTopDelta: number;
  yBottomDelta: number;
  pageCount?: number;
}): Promise<RunOutput> {
  const { sections, allQuestions, xLeftDelta, xRightDelta, yTopDelta, yBottomDelta } = args;
  const sectionQuestionIds = collectSectionQuestionIds(sections, allQuestions);

  if (sectionQuestionIds.size === 0) {
    return { updated: 0, warnings: ["No questions found in metadata.englishSections for this section."], perSection: [], bounds: [] };
  }

  const { detectionsByPage, warnings } = await detectAcrossSectionPages({
    paperId: args.paperId,
    sectionQuestionIds,
    allQuestions,
    sectionHint: args.sectionHint,
    pageCount: args.pageCount,
  });

  if (detectionsByPage.size === 0) {
    warnings.push("No pages with detectable question numbers — has Clean Extract run on this paper?");
    return { updated: 0, warnings, perSection: [], bounds: [] };
  }

  const detByNum = flattenDetections(detectionsByPage);

  let updated = 0;
  const perSection: Array<{ label: string; updated: number }> = [];
  const bounds: QuestionBound[] = [];

  for (const sec of sections) {
    let sectionUpdated = 0;
    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
      const q = allQuestions[qi];
      const det = detByNum.get(q.questionNum) ?? detByNum.get(normalizeQuestionNum(q.questionNum));
      if (!det) {
        warnings.push(`Q${q.questionNum} not detected by Gemini on any scanned page.`);
        bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: q.pageIndex, yStartPct: null, yEndPct: null, xStartPct: null, xEndPct: null, status: "not_detected" });
        continue;
      }
      const yStart = clampPct(det.yPctTop - yTopDelta);
      const yEnd = clampPct(det.yPctTop + yBottomDelta);
      const xStart = clampPct(det.xPctLeft - xLeftDelta);
      const xEnd = clampPct(det.xPctLeft + xRightDelta);
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { yStartPct: yStart, yEndPct: yEnd, xStartPct: xStart, xEndPct: xEnd, pageIndex: det.pageIdx },
      });
      sectionUpdated++;
      updated++;
      bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: det.pageIdx, yStartPct: yStart, yEndPct: yEnd, xStartPct: xStart, xEndPct: xEnd, status: "updated" });
    }
    perSection.push({ label: sec.label, updated: sectionUpdated });
  }

  return { updated, warnings, perSection, bounds };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { sectionType?: SectionType; qNumPosition?: "above" | "right" };
  const sectionType = body.sectionType;
  // Cloze Q-number position. "above" (default) = standard PSLE
  // layout where (N) is printed below the blank in the passage.
  // "right" = school-paper variant where (N) sits to the right of
  // the blank, like editing. Swaps the crop deltas to editing-style
  // when "right". Ignored for non-cloze sections.
  const qNumPosition: "above" | "right" = body.qNumPosition === "right" ? "right" : "above";
  if (!sectionType || !SECTION_LABELS[sectionType]) {
    return NextResponse.json({ error: "Body { sectionType } must be one of: booklet-a, grammar-cloze, editing, comp-cloze, synthesis, comp-oeq" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, subject: true, level: true, pageCount: true, metadata: true,
      questions: {
        select: { id: true, questionNum: true, pageIndex: true, orderIndex: true, syllabusTopic: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!(paper.subject ?? "").toLowerCase().includes("english")) {
    return NextResponse.json({ error: "This route is English-only. Use the math/science pipeline for other subjects." }, { status: 400 });
  }

  type PapersEntry = { label: string; questionsStartPage?: number; expectedQuestions?: number };
  const meta = (paper.metadata ?? {}) as {
    englishSections?: SecMeta[];
    normalExtractEnglish?: NormalExtractState;
    papers?: PapersEntry[];
  };
  let sections: SecMeta[] = (meta.englishSections ?? []).filter(s => sectionMatches(s.label, sectionType));
  console.log(`[normal-extract] sectionType=${sectionType}, englishSections matched: ${sections.length}`);

  // Fallback 1: per-syllabusTopic groupings. Clean Extract tags every
  // question with its section name (e.g. "Grammar Cloze", "Vocabulary
  // MCQ", "Comprehension Open Ended") even on PSLE / school papers
  // that don't carry englishSections metadata. Group consecutive
  // questions by topic, then keep groups whose topic matches the
  // requested sectionType.
  //
  // This used to be Fallback 2, behind a metadata.papers-based
  // pageIndex-range filter for booklet-a. That broke on P5 school
  // papers where Clean Extract tagged Vocab MCQ / Vocab Cloze /
  // Visual Text MCQ all with pageIndex=0 (the cover), excluding
  // Q11-Q25 from the section entirely. Topic groupings are immune
  // to pageIndex drift since they use the explicit topic label.
  if (sections.length === 0) {
    const groups: Array<{ topic: string; startIndex: number; endIndex: number }> = [];
    let currentTopic: string | null = null;
    for (let i = 0; i < paper.questions.length; i++) {
      const t = paper.questions[i].syllabusTopic;
      if (!t) { currentTopic = null; continue; }
      if (t !== currentTopic) {
        groups.push({ topic: t, startIndex: i, endIndex: i });
        currentTopic = t;
      } else {
        groups[groups.length - 1].endIndex = i;
      }
    }
    sections = groups
      .filter(g => sectionMatches(g.topic, sectionType))
      .map(g => ({ label: g.topic, startIndex: g.startIndex, endIndex: g.endIndex }));
    console.log(`[normal-extract] topic fallback → ${sections.length} sections: ${sections.map(s => `"${s.label}"[${s.startIndex}..${s.endIndex}]`).join(", ")}`);
  }

  // Fallback 2: PSLE-style Booklet A using metadata.papers page ranges.
  // Last resort when neither englishSections nor syllabusTopic groupings
  // produced anything. Uses the booklet's printed page range and pulls
  // every question whose pageIndex falls in it — fragile because Clean
  // Extract can tag questions with the wrong page.
  if (sections.length === 0 && sectionType === "booklet-a" && Array.isArray(meta.papers)) {
    const bookletA = meta.papers.find(p => /booklet a/i.test(p.label));
    const bookletB = meta.papers.find(p => /booklet b/i.test(p.label));
    if (bookletA?.questionsStartPage) {
      const startPage = bookletA.questionsStartPage - 1; // 1-based → 0-based
      const endPage = bookletB?.questionsStartPage ? bookletB.questionsStartPage - 1 : Infinity;
      const matchingIndices: number[] = [];
      for (let i = 0; i < paper.questions.length; i++) {
        const q = paper.questions[i];
        if (q.pageIndex != null && q.pageIndex >= startPage && q.pageIndex < endPage) {
          matchingIndices.push(i);
        }
      }
      if (matchingIndices.length > 0) {
        sections = [{
          label: bookletA.label,
          startIndex: matchingIndices[0],
          endIndex: matchingIndices[matchingIndices.length - 1],
        }];
        console.log(`[normal-extract] metadata.papers fallback → 1 section "${bookletA.label}"[${matchingIndices[0]}..${matchingIndices[matchingIndices.length - 1]}] (${matchingIndices.length} questions in page range [${startPage},${endPage}))`);
      }
    }
  }

  if (sections.length === 0) {
    const availableTopics = [...new Set(paper.questions.map(q => q.syllabusTopic).filter(Boolean))];
    const detail = sectionType === "booklet-a"
      ? "Couldn't resolve Booklet A from englishSections, metadata.papers, or per-question syllabusTopic. Make sure Clean Extract has run on this paper."
      : `No matching section for sectionType="${sectionType}". Checked metadata.englishSections, metadata.papers, and per-question syllabusTopic — nothing matched.`;
    return NextResponse.json({
      error: detail,
      availableSectionLabels: (meta.englishSections ?? []).map(s => s.label),
      availablePapers: (meta.papers ?? []).map(p => ({ label: p.label, expectedQuestions: p.expectedQuestions, questionsStartPage: p.questionsStartPage })),
      availableSyllabusTopics: availableTopics,
    }, { status: 400 });
  }

  // For booklet-a, prefer the metadata.papers booklet range as the
  // explicit scan range. Clean Extract sometimes assigns wildly wrong
  // pageIndex values to MCQ questions (e.g. Listening Comp pages,
  // page 0 cover); the booklet's known startPage from metadata is
  // far more reliable than the question-level pageIndex.
  let bookletAPageRange: { start: number; endExclusive: number } | undefined;
  if (sectionType === "booklet-a" && Array.isArray(meta.papers)) {
    const bookletA = meta.papers.find(p => /booklet a/i.test(p.label));
    const bookletB = meta.papers.find(p => /booklet b/i.test(p.label));
    if (bookletA?.questionsStartPage) {
      const start = Math.max(0, bookletA.questionsStartPage - 1); // 1-based → 0-based
      const endExclusive = bookletB?.questionsStartPage
        ? Math.max(start + 1, bookletB.questionsStartPage - 1)
        : Math.min((paper.pageCount ?? Infinity), start + 12); // 12-page cap if Booklet B unknown
      bookletAPageRange = { start, endExclusive };
      console.log(`[normal-extract] booklet-a pageRange from metadata.papers = [${start}, ${endExclusive})`);
    }
  }

  let result: RunOutput;
  switch (sectionType) {
    case "booklet-a":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Booklet A MCQ stack (Grammar / Vocab / Vocab Cloze / Visual Text), sequential numbering. For Vocab Cloze MCQ in particular, the question numbers are in the MCQ LIST BELOW the passage (each followed by four (1)/(2)/(3)/(4) options), NOT the (N) markers inline within the passage text",
        pageCount: paper.pageCount ?? undefined,
        pageRange: bookletAPageRange,
        // Booklet A's hint mentions "Vocab Cloze", which would otherwise
        // trigger inline-(N) detection. Force it OFF — Vocab Cloze MCQ
        // is an MCQ list below the passage, not inline blanks.
        isClozeSectionOverride: false,
      });
      break;
    case "comp-oeq":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Comprehension open-ended questions, sequential numbering, multi-line stems",
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "grammar-cloze":
      // P4 quirk: some P4 school papers (e.g. Tao Nan SA2) ship TWO
      // Grammar Cloze passages back-to-back -- a word-bank one (~4
      // Qs, table at top of page) then a 2-option inline word-choice
      // one (~4 Qs, stems like `(N) [optA / optB]`). The post-pass
      // at `postProcessP4GrammarCloze` (run below the switch) handles
      // the 2-option ones: rewrites the stem to the canonical
      // `**(N)________** [optA/optB]` form and stores the options on
      // transcribedOptions. P5/P6 papers skip the post-pass.
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: qNumPosition === "right"
          ? "Grammar Cloze (school variant) — Q-number sits to the RIGHT of the answer blank, like editing"
          : "Grammar Cloze — numbered blanks inline within a passage",
        // PSLE (above): Q-number printed BELOW the blank — yStart 3% above
        // the Q-number top, xLeft -5, xRight +11.
        // School (right): Q-number printed RIGHT of the blank — fall back
        // to editing's wider yRange + far-right x extension.
        ...(qNumPosition === "right"
          ? { xLeftDelta: 0, xRightDelta: 25, yTopDelta: 2.5, yBottomDelta: 2.5 }
          : { xLeftDelta: 5, xRightDelta: 11, yTopDelta: 3, yBottomDelta: 0 }),
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "comp-cloze":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: qNumPosition === "right"
          ? "Comprehension Cloze (school variant) — Q-number sits to the RIGHT of the answer blank, like editing"
          : "Comprehension Cloze — numbered blanks inline within a passage",
        // Same dual-layout split as Grammar Cloze above.
        ...(qNumPosition === "right"
          ? { xLeftDelta: 0, xRightDelta: 25, yTopDelta: 2.5, yBottomDelta: 2.5 }
          : { xLeftDelta: 8, xRightDelta: 12, yTopDelta: 4.5, yBottomDelta: 0 }),
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "editing":
      // qNumPosition is named after where the ANSWER AREA sits
      // relative to the (N) anchor — the same toggle the cloze
      // sections use. For Editing, the convention an admin uses is
      // "the word I want to extract sits ABOVE / TO THE RIGHT OF the
      // (N) number":
      //
      //   - "above" (school variant)  : word sits ABOVE the (N) inline.
      //                                  Crop extends UPWARD.
      //   - "right" (school variant)  : word sits TO THE RIGHT of the
      //                                  (N) inline.                Crop
      //                                  extends RIGHTWARD past the (N).
      //   - DEFAULT (standard PSLE)   : (N) printed in the LEFT margin
      //                                  column, word on the same row in
      //                                  the body.                  Crop
      //                                  extends RIGHTWARD past the (N).
      //
      // DEFAULT and "right" both extend rightward but differ in
      // anchor-relative tightness: the margin-column default needs
      // a wide rightward sweep to clear the margin gap before
      // landing on the word, while the inline "right" variant has
      // the word tight against the (N) and benefits from a slimmer
      // y-band so neighbouring lines don't bleed in.
      //
      // Earlier rev shipped "right" with xLeftDelta=25 / xRightDelta=0
      // — that extended LEFTWARD and the admin reported the crop
      // landed on the wrong side of the (N).
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: qNumPosition === "above"
          ? "Editing (school variant) — numbered errors in a passage, underlined word sits ABOVE the (N) number inline"
          : qNumPosition === "right"
          ? "Editing (school variant) — numbered errors in a passage, underlined word sits to the RIGHT of the (N) number inline (no margin column)"
          : "Editing — numbered errors in a passage, (N) sits in the LEFT MARGIN column and the underlined word is on the same row in the body text",
        // y deltas at ±2.5% (5% total) — editing rows are single-line.
        // "above":  x stays close (5/16), y extends upward 4%.
        // "right":  x extends rightward 21% (tighter than default
        //           because the word is inline-tight, not across a
        //           margin gap). y ±2% to keep the row narrow.
        // DEFAULT:  x extends rightward 26% across the margin gap.
        // (xRightDelta bumped +1 across all variants — admin wanted
        // a little more room past the corrected word so longer
        // corrections / a trailing answer box edge don't get cropped.)
        ...(qNumPosition === "above"
          ? { xLeftDelta: 5, xRightDelta: 16, yTopDelta: 4, yBottomDelta: 0 }
          : qNumPosition === "right"
          ? { xLeftDelta: 0, xRightDelta: 21, yTopDelta: 2, yBottomDelta: 2 }
          : { xLeftDelta: 0, xRightDelta: 26, yTopDelta: 2.5, yBottomDelta: 2.5 }),
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "synthesis":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Synthesis / Transformation — combine the two sentences using the bolded keyword; student writes 2-3 lines below",
        // Synthesis: yStart at the Q-number top, yEnd 10% below.
        // Wide x: -5 left to keep some margin, +75 right for the
        // full writing area.
        xLeftDelta: 5, xRightDelta: 75, yTopDelta: 0, yBottomDelta: 10,
        pageCount: paper.pageCount ?? undefined,
      });
      break;
  }

  // P4 English Grammar Cloze post-pass. School papers in this band
  // often pair the standard word-bank passage with a second 2-option
  // inline word-choice passage; the OCR step above stores both
  // verbatim, so the second passage's stems land as
  // `(N) [optA / optB] ...`. The kid's quiz / marking pipeline can't
  // parse that shape -- it expects either a clean cloze blank with
  // separate transcribedOptions OR a non-MCQ stem. Rewrite each
  // matching stem in-place to `... **(N)________** [optA/optB] ...`
  // (the bold-marker form PassageWithInputs already parses) and store
  // the two options on transcribedOptions. P5/P6 skip the post-pass.
  const isP4 = sectionType === "grammar-cloze" && /\bP\s*4\b|primary\s*4/i.test(paper.level ?? "");
  let p4Rewritten = 0;
  if (isP4) {
    p4Rewritten = await postProcessP4GrammarCloze(paper.id, sections, paper.questions);
    console.log(`[normal-extract] P4 grammar-cloze post-pass: rewrote ${p4Rewritten} stems.`);
  }

  // Map sectionType -> the corresponding metadata flag.
  const flagKey: Record<SectionType, keyof NormalExtractState> = {
    "booklet-a": "bookletA",
    "grammar-cloze": "grammarCloze",
    "editing": "editing",
    "comp-cloze": "compCloze",
    "synthesis": "synthesis",
    "comp-oeq": "compOeq",
  };
  const updatedState: NormalExtractState = {
    ...(meta.normalExtractEnglish ?? {}),
    [flagKey[sectionType]]: result.updated > 0,
    lastRunAt: new Date().toISOString(),
  };
  await prisma.examPaper.update({
    where: { id: paper.id },
    data: {
      metadata: { ...meta, normalExtractEnglish: updatedState } as never,
    },
  });

  return NextResponse.json({
    sectionType,
    updated: result.updated,
    perSection: result.perSection,
    warnings: result.warnings,
    bounds: result.bounds,
    state: updatedState,
    p4GrammarClozeRewritten: isP4 ? p4Rewritten : undefined,
  });
}

// P4 Grammar Cloze 2-option post-pass. Walks every question whose
// orderIndex falls inside any grammar-cloze section, reads the
// freshly-OCR'd transcribedStem, and -- if it matches the inline
// 2-option layout `(N) [optA / optB]` -- rewrites it to the
// canonical `**(N)________** [optA/optB]` form + stores the two
// options on transcribedOptions. Returns the number of stems
// rewritten.
//
// Detection regex is permissive: matches `(28) [ goes / go ]`,
// `(28)[goes/go]`, `(28) [ doesn't / don't ]`. The brackets and
// slash are the signal -- standard cloze stems carry neither.
async function postProcessP4GrammarCloze(
  paperId: string,
  sections: SecMeta[],
  allQuestions: Array<{ id: string; orderIndex: number }>,
): Promise<number> {
  if (sections.length === 0) return 0;
  // Collect the questionIds inside any section's [startIndex, endIndex] range.
  const sectionIds = new Set<string>();
  for (const sec of sections) {
    for (let i = sec.startIndex; i <= sec.endIndex; i++) {
      const q = allQuestions[i];
      if (q) sectionIds.add(q.id);
    }
  }
  if (sectionIds.size === 0) return 0;

  // Re-pull the questions' current stems (extractAnchoredCrop above
  // just updated them; we need the fresh values, not the snapshot
  // from paper.findUnique at the top of the route).
  const qs = await prisma.examQuestion.findMany({
    where: { id: { in: [...sectionIds] } },
    select: { id: true, questionNum: true, transcribedStem: true },
  });

  // `(N) [optA <SEP> optB]` (labelled) OR plain `[optA <SEP> optB]`
  // (no inline number — the question's row identifies it). SEP is
  // "/" or "," — both used by school printers (Maha Bodhi 2025 used
  // comma + label; Bedok Green 2025 P4 P2 used slash + no label).
  // optA/optB exclude both separators AND the close bracket so a
  // comma inside an option can't bleed into the second slot.
  const TWO_OPTION_LABELLED_RE = /\((\d+)\)\s*\[\s*([^\/,\]]+?)\s*[\/,]\s*([^\/,\]]+?)\s*\]/;
  const TWO_OPTION_BARE_RE = /\[\s*([^\/,\]]+?)\s*[\/,]\s*([^\/,\]]+?)\s*\]/;

  let rewritten = 0;
  for (const q of qs) {
    const stem = q.transcribedStem ?? "";
    // Idempotency guard: if the stem already carries the rewritten
    // `**(N)________**` marker for THIS question, skip — running the
    // post-pass a second time used to double up the marker (saw
    // "he **(25)________** **(25)________** [walk/walks]" on the Bedok
    // Green Booklet A after re-extracting).
    if (stem.includes(`**(${q.questionNum})________**`)) continue;
    let whole: string;
    let qNum: string;
    let optA: string;
    let optB: string;
    const m1 = TWO_OPTION_LABELLED_RE.exec(stem);
    if (m1) {
      whole = m1[0]; qNum = m1[1]; optA = m1[2]; optB = m1[3];
      // Labelled — guard against landing on an unrelated bracket pair
      // by requiring the captured (N) match the question's own number.
      if (qNum !== q.questionNum) continue;
    } else {
      const m2 = TWO_OPTION_BARE_RE.exec(stem);
      if (m2) {
        whole = m2[0]; qNum = q.questionNum; optA = m2[1]; optB = m2[2];
      } else {
        // Word-bank cloze case: stem has a `___` blank (no [optA, optB]
        // brackets). Two shapes seen in P4 papers:
        //   · labelled: `(17) ___` — Bedok Green 2025 P4 Booklet B
        //   · bare: `___` only — earlier OCR sometimes drops the label
        // Some transcribers also emit markdown-escaped underscores
        // (`\_\_\_`) instead of raw `___`, so accept both.
        const BLANK = String.raw`(?:\\_|_){3,}`;
        const LABELLED_BLANK_RE = new RegExp(String.raw`\(` + q.questionNum + String.raw`\)\s*` + BLANK);
        const PLAIN_BLANK_RE = new RegExp(BLANK);
        const m3 = LABELLED_BLANK_RE.exec(stem) ?? PLAIN_BLANK_RE.exec(stem);
        if (!m3) continue;
        const newStem = stem.replace(m3[0], `**(${q.questionNum})________**`);
        await prisma.examQuestion.update({
          where: { id: q.id },
          data: { transcribedStem: newStem },
        });
        rewritten++;
        continue;
      }
    }
    const replacement = `**(${qNum})________** [${optA.trim()}/${optB.trim()}]`;
    const newStem = stem.replace(whole, replacement);
    await prisma.examQuestion.update({
      where: { id: q.id },
      data: {
        transcribedStem: newStem,
        // 2-element transcribedOptions so the daily-quiz `hasOptions`
        // check (`length === 4`) keeps treating the row as cloze, not
        // MCQ. Marking + UI consume the bracket text inline.
        transcribedOptions: [optA.trim(), optB.trim()],
      },
    });
    rewritten++;
  }
  return rewritten;
}

// Read-only view of the currently-stored bounds for a section.
// Lets the admin page render the per-question crop grid on initial
// load without re-running extraction (extraction is expensive and
// destructive — it overwrites any manual recrops). Used by the
// /exam/[id]/normal-extract page on mount.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { id } = await params;
  const sectionType = request.nextUrl.searchParams.get("sectionType") as SectionType | null;
  if (!sectionType || !SECTION_LABELS[sectionType]) {
    return NextResponse.json({ error: "Query ?sectionType= must be one of: booklet-a, grammar-cloze, editing, comp-cloze, comp-oeq" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, subject: true, metadata: true,
      questions: {
        select: { id: true, questionNum: true, pageIndex: true, orderIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true, syllabusTopic: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!(paper.subject ?? "").toLowerCase().includes("english")) {
    return NextResponse.json({ error: "This route is English-only." }, { status: 400 });
  }

  type PapersEntry = { label: string; questionsStartPage?: number; expectedQuestions?: number };
  const meta = (paper.metadata ?? {}) as {
    englishSections?: SecMeta[];
    papers?: PapersEntry[];
  };
  let sections: SecMeta[] = (meta.englishSections ?? []).filter(s => sectionMatches(s.label, sectionType));

  // Fallback 1: PSLE-style Booklet A using metadata.papers page ranges.
  if (sections.length === 0 && sectionType === "booklet-a" && Array.isArray(meta.papers)) {
    const bookletA = meta.papers.find(p => /booklet a/i.test(p.label));
    const bookletB = meta.papers.find(p => /booklet b/i.test(p.label));
    if (bookletA?.questionsStartPage) {
      const startPage = bookletA.questionsStartPage - 1;
      const endPage = bookletB?.questionsStartPage ? bookletB.questionsStartPage - 1 : Infinity;
      const matchingIndices: number[] = [];
      for (let i = 0; i < paper.questions.length; i++) {
        const q = paper.questions[i];
        if (q.pageIndex != null && q.pageIndex >= startPage && q.pageIndex < endPage) {
          matchingIndices.push(i);
        }
      }
      if (matchingIndices.length > 0) {
        sections = [{
          label: bookletA.label,
          startIndex: matchingIndices[0],
          endIndex: matchingIndices[matchingIndices.length - 1],
        }];
      }
    }
  }

  // Fallback 2: derive sections from question.syllabusTopic groupings
  // (same as POST). Lets Booklet B view-bounds work on PSLE papers.
  if (sections.length === 0) {
    const groups: Array<{ topic: string; startIndex: number; endIndex: number }> = [];
    let currentTopic: string | null = null;
    for (let i = 0; i < paper.questions.length; i++) {
      const t = paper.questions[i].syllabusTopic;
      if (!t) { currentTopic = null; continue; }
      if (t !== currentTopic) {
        groups.push({ topic: t, startIndex: i, endIndex: i });
        currentTopic = t;
      } else {
        groups[groups.length - 1].endIndex = i;
      }
    }
    sections = groups
      .filter(g => sectionMatches(g.topic, sectionType))
      .map(g => ({ label: g.topic, startIndex: g.startIndex, endIndex: g.endIndex }));
  }

  if (sections.length === 0) {
    return NextResponse.json({ bounds: [], sections: [] });
  }

  const bounds: QuestionBound[] = [];
  const perSection: Array<{ label: string; count: number }> = [];
  for (const sec of sections) {
    let count = 0;
    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < paper.questions.length; qi++) {
      const q = paper.questions[qi];
      const hasBounds = q.yStartPct != null && q.yEndPct != null && q.pageIndex != null;
      bounds.push({
        id: q.id,
        questionNum: q.questionNum,
        pageIndex: q.pageIndex,
        yStartPct: q.yStartPct,
        yEndPct: q.yEndPct,
        xStartPct: q.xStartPct,
        xEndPct: q.xEndPct,
        status: hasBounds ? "updated" : "not_detected",
      });
      count++;
    }
    perSection.push({ label: sec.label, count });
  }

  return NextResponse.json({ bounds, sections: perSection });
}

// Manual recrop — update a single question's bounds when extraction
// missed it or wrong-bucketed it (e.g. Q26-Q28 in PSLE English 2024
// where Clean Extract tagged them onto a Booklet A page but they're
// really Booklet B OEQs on a later page).
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as {
    questionId?: string;
    pageIndex?: number | null;
    yStartPct?: number | null;
    yEndPct?: number | null;
    xStartPct?: number | null;
    xEndPct?: number | null;
  };
  if (!body.questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });
  const q = await prisma.examQuestion.findUnique({
    where: { id: body.questionId },
    select: { examPaperId: true, questionNum: true },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  if (q.examPaperId !== id) return NextResponse.json({ error: "Question does not belong to this paper" }, { status: 400 });

  const data: Record<string, number | null> = {};
  if (body.pageIndex !== undefined && body.pageIndex !== null) data.pageIndex = body.pageIndex;
  if (body.yStartPct !== undefined) data.yStartPct = body.yStartPct === null ? null : clampPct(body.yStartPct);
  if (body.yEndPct !== undefined) data.yEndPct = body.yEndPct === null ? null : clampPct(body.yEndPct);
  if (body.xStartPct !== undefined) data.xStartPct = body.xStartPct === null ? null : clampPct(body.xStartPct);
  if (body.xEndPct !== undefined) data.xEndPct = body.xEndPct === null ? null : clampPct(body.xEndPct);

  const updated = await prisma.examQuestion.update({
    where: { id: body.questionId },
    data,
    select: { id: true, questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true },
  });
  return NextResponse.json({ ok: true, bound: { ...updated, status: "updated" } });
}
