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
  "comp-oeq": [/comprehension open ended/i, /comprehension oeq/i],
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
): Promise<Detection[]> {
  const prompt = `You are reading page ${pageIndex + 1} of a Singapore PSLE English paper. The section on this page is: ${sectionHint}.

Identify EVERY question number that is the START of a question on this page (a numbered question stem or numbered blank, NOT a page number, NOT a reference inside text).

For each one, report:
- "questionNum": the bare number as it appears (e.g. "1", "12", "21")
- "xPctLeft": horizontal position of the LEFT edge of the question number, as a percentage of the page width from the left (0 = far left, 100 = far right)
- "yPctTop": vertical position of the TOP edge of the question number, as a percentage of the page height from the top (0 = very top, 100 = very bottom)

Expected question numbers in this paper: ${expectedQuestionNums.join(", ")}. Match the printed number against this list and IGNORE any number on the page that isn't in the expected list.

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
}): Promise<{ detectionsByPage: Map<number, Detection[]>; warnings: string[] }> {
  const { paperId, sectionQuestionIds, allQuestions, sectionHint, pageRange } = args;
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
      const min = Math.min(...stored);
      const max = Math.max(...stored);
      for (let i = min; i <= max; i++) pagesToScan.push(i);
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
  const results = await Promise.all(pagesToScan.map(async (pageIdx) => {
    const pagePath = path.join(PAGES_DIR, paperId, `page_${pageIdx}.jpg`);
    let pageBytes: Buffer;
    try {
      pageBytes = await fs.readFile(pagePath);
    } catch {
      return { pageIdx, warning: `Page image not found on disk: page_${pageIdx}.jpg`, detections: null as Detection[] | null };
    }
    const detections = await findQuestionPositionsOnPage(pageBytes, pageIdx, expectedNums, sectionHint);
    return { pageIdx, warning: null as string | null, detections };
  }));

  for (const r of results) {
    if (r.warning) warnings.push(r.warning);
    if (r.detections) detectionsByPage.set(r.pageIdx, r.detections);
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

// Build a global { questionNum -> { pageIdx, yPctTop, xPctLeft } } map
// from all per-page Gemini detections. Trusts whichever page detected
// the question rather than the question's stored pageIndex — heals
// papers where Clean Extract assigned the wrong page.
function flattenDetections(detectionsByPage: Map<number, Detection[]>): Map<string, { pageIdx: number; yPctTop: number; xPctLeft: number }> {
  const out = new Map<string, { pageIdx: number; yPctTop: number; xPctLeft: number }>();
  for (const [pageIdx, dets] of detectionsByPage.entries()) {
    for (const d of dets) {
      if (!out.has(d.questionNum)) {
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
      const det = detByNum.get(q.questionNum);
      if (!det) {
        warnings.push(`Q${q.questionNum} not detected by Gemini on any scanned page.`);
        bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: q.pageIndex, yStartPct: null, yEndPct: null, xStartPct: null, xEndPct: null, status: "not_detected" });
        continue;
      }
      const samePageSorted = sectionQuestions
        .map(qq => {
          const d = detByNum.get(qq.questionNum);
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
      const det = detByNum.get(q.questionNum);
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
  const body = await request.json().catch(() => ({})) as { sectionType?: SectionType };
  const sectionType = body.sectionType;
  if (!sectionType || !SECTION_LABELS[sectionType]) {
    return NextResponse.json({ error: "Body { sectionType } must be one of: booklet-a, grammar-cloze, editing, comp-cloze, synthesis, comp-oeq" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, subject: true, pageCount: true, metadata: true,
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

  // Fallback 1: PSLE-style Booklet A using metadata.papers page ranges.
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
      }
    }
  }

  // Fallback 2: derive sections from question.syllabusTopic groupings.
  // Clean Extract tags each question with its section name (e.g. "Grammar
  // Cloze", "Editing (Spelling & Grammar)", "Comprehension Cloze",
  // "Comprehension Open Ended") even on PSLE papers that don't carry
  // englishSections metadata. Group consecutive questions by topic, then
  // keep groups whose topic matches the requested sectionType.
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

  let result: RunOutput;
  switch (sectionType) {
    case "booklet-a":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Booklet A MCQ stack (Grammar / Vocab / Vocab Cloze / Visual Text), sequential numbering",
      });
      break;
    case "comp-oeq":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Comprehension open-ended questions, sequential numbering, multi-line stems",
      });
      break;
    case "grammar-cloze":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Grammar Cloze — numbered blanks inline within a passage",
        // Grammar Cloze: yStart 3% above Q-number top, yEnd at top.
        // xLeft -5%, xRight +11%.
        xLeftDelta: 5, xRightDelta: 11, yTopDelta: 3, yBottomDelta: 0,
      });
      break;
    case "comp-cloze":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Comprehension Cloze — numbered blanks inline within a passage",
        // Comp Cloze: yStart 5% above Q-number; yEnd at Q-number top.
        // xLeft -8, xRight +12.
        xLeftDelta: 8, xRightDelta: 12, yTopDelta: 5, yBottomDelta: 0,
      });
      break;
    case "editing":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Editing — numbered errors in a passage, question number sits to the left of the word being corrected",
        // y deltas at ±2.5% (5% total) — editing rows are single-line.
        // xRight pushed out to +25% so the full corrected word /
        // clause + a comfortable margin to the right fits in the crop.
        xLeftDelta: 0, xRightDelta: 25, yTopDelta: 2.5, yBottomDelta: 2.5,
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
      });
      break;
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
  });
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
