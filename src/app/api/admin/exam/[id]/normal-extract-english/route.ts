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

type SectionType = "booklet-a" | "grammar-cloze" | "editing" | "comp-cloze" | "comp-oeq";
type SecMeta = { label: string; startIndex: number; endIndex: number; passage?: string };
type NormalExtractState = {
  bookletA?: boolean;
  grammarCloze?: boolean;
  editing?: boolean;
  compCloze?: boolean;
  compOeq?: boolean;
  lastRunAt?: string;
};
type QuestionRow = { id: string; questionNum: string; pageIndex: number | null };
type Detection = { questionNum: string; xPctLeft: number; yPctTop: number };
type RunOutput = { updated: number; warnings: string[]; perSection: Array<{ label: string; updated: number }> };

const SECTION_LABELS: Record<SectionType, RegExp[]> = {
  "booklet-a": [
    /grammar mcq/i,
    /vocabulary mcq$/i,
    /vocabulary cloze mcq/i,
    /visual text comprehension mcq/i,
  ],
  "grammar-cloze": [/grammar cloze/i],
  "editing": [/editing/i],
  "comp-cloze": [/comprehension cloze/i],
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

// Collect detections for every page that holds at least one of the
// section's questions. Returns a map pageIndex -> detections, plus
// any warnings about missing page images.
async function detectAcrossSectionPages(args: {
  paperId: string;
  sectionQuestionIds: Set<string>;
  allQuestions: QuestionRow[];
  sectionHint: string;
}): Promise<{ detectionsByPage: Map<number, Detection[]>; warnings: string[] }> {
  const { paperId, sectionQuestionIds, allQuestions, sectionHint } = args;
  const warnings: string[] = [];
  const sectionPages = new Set<number>();
  for (const q of allQuestions) {
    if (sectionQuestionIds.has(q.id) && q.pageIndex != null) sectionPages.add(q.pageIndex);
  }
  const detectionsByPage = new Map<number, Detection[]>();
  if (sectionPages.size === 0) return { detectionsByPage, warnings };

  const expectedNums = [...sectionQuestionIds]
    .map(id => allQuestions.find(q => q.id === id)?.questionNum)
    .filter(Boolean) as string[];

  for (const pageIdx of [...sectionPages].sort((a, b) => a - b)) {
    const pagePath = path.join(PAGES_DIR, paperId, `page_${pageIdx}.jpg`);
    let pageBytes: Buffer;
    try {
      pageBytes = await fs.readFile(pagePath);
    } catch {
      warnings.push(`Page image not found on disk: page_${pageIdx}.jpg`);
      continue;
    }
    const detections = await findQuestionPositionsOnPage(pageBytes, pageIdx, expectedNums, sectionHint);
    detectionsByPage.set(pageIdx, detections);
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
    return { updated: 0, warnings: ["No questions found in metadata.englishSections for this section."], perSection: [] };
  }

  const { detectionsByPage, warnings } = await detectAcrossSectionPages({
    paperId: args.paperId,
    sectionQuestionIds,
    allQuestions,
    sectionHint: args.sectionHint,
  });

  if (detectionsByPage.size === 0) {
    warnings.push("No pages with detectable question numbers — has Clean Extract run on this paper?");
    return { updated: 0, warnings, perSection: [] };
  }

  let updated = 0;
  const perSection: Array<{ label: string; updated: number }> = [];

  for (const sec of sections) {
    let sectionUpdated = 0;
    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
      const q = allQuestions[qi];
      const pageIdx = q.pageIndex;
      if (pageIdx == null) continue;
      const detections = detectionsByPage.get(pageIdx) ?? [];
      const sorted = [...detections].sort((a, b) => a.yPctTop - b.yPctTop);
      const myIdx = sorted.findIndex(d => d.questionNum === q.questionNum);
      if (myIdx < 0) {
        warnings.push(`Q${q.questionNum} (page ${pageIdx + 1}) not detected by Gemini.`);
        continue;
      }
      const yStart = sorted[myIdx].yPctTop;
      const yEnd = myIdx + 1 < sorted.length ? sorted[myIdx + 1].yPctTop : 100;
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { yStartPct: yStart, yEndPct: yEnd, xStartPct: null, xEndPct: null },
      });
      sectionUpdated++;
      updated++;
    }
    perSection.push({ label: sec.label, updated: sectionUpdated });
  }

  return { updated, warnings, perSection };
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
    return { updated: 0, warnings: ["No questions found in metadata.englishSections for this section."], perSection: [] };
  }

  const { detectionsByPage, warnings } = await detectAcrossSectionPages({
    paperId: args.paperId,
    sectionQuestionIds,
    allQuestions,
    sectionHint: args.sectionHint,
  });

  if (detectionsByPage.size === 0) {
    warnings.push("No pages with detectable question numbers — has Clean Extract run on this paper?");
    return { updated: 0, warnings, perSection: [] };
  }

  let updated = 0;
  const perSection: Array<{ label: string; updated: number }> = [];

  for (const sec of sections) {
    let sectionUpdated = 0;
    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
      const q = allQuestions[qi];
      const pageIdx = q.pageIndex;
      if (pageIdx == null) continue;
      const detections = detectionsByPage.get(pageIdx) ?? [];
      const hit = detections.find(d => d.questionNum === q.questionNum);
      if (!hit) {
        warnings.push(`Q${q.questionNum} (page ${pageIdx + 1}) not detected by Gemini.`);
        continue;
      }
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: {
          yStartPct: clampPct(hit.yPctTop - yTopDelta),
          yEndPct: clampPct(hit.yPctTop + yBottomDelta),
          xStartPct: clampPct(hit.xPctLeft - xLeftDelta),
          xEndPct: clampPct(hit.xPctLeft + xRightDelta),
        },
      });
      sectionUpdated++;
      updated++;
    }
    perSection.push({ label: sec.label, updated: sectionUpdated });
  }

  return { updated, warnings, perSection };
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
    return NextResponse.json({ error: "Body { sectionType } must be one of: booklet-a, grammar-cloze, editing, comp-cloze, comp-oeq" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, subject: true, pageCount: true, metadata: true,
      questions: {
        select: { id: true, questionNum: true, pageIndex: true, orderIndex: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!(paper.subject ?? "").toLowerCase().includes("english")) {
    return NextResponse.json({ error: "This route is English-only. Use the math/science pipeline for other subjects." }, { status: 400 });
  }

  const meta = (paper.metadata ?? {}) as { englishSections?: SecMeta[]; normalExtractEnglish?: NormalExtractState };
  const sections = (meta.englishSections ?? []).filter(s => sectionMatches(s.label, sectionType));
  if (sections.length === 0) {
    return NextResponse.json({ error: `No matching sections in metadata.englishSections for sectionType="${sectionType}"`, availableLabels: (meta.englishSections ?? []).map(s => s.label) }, { status: 400 });
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
        xLeftDelta: 6, xRightDelta: 6, yTopDelta: 5, yBottomDelta: 5,
      });
      break;
    case "comp-cloze":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Comprehension Cloze — numbered blanks inline within a passage",
        xLeftDelta: 6, xRightDelta: 6, yTopDelta: 5, yBottomDelta: 5,
      });
      break;
    case "editing":
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "Editing — numbered errors in a passage, question number sits to the left of the word being corrected",
        xLeftDelta: 0, xRightDelta: 15, yTopDelta: 5, yBottomDelta: 5,
      });
      break;
  }

  // Map sectionType -> the corresponding metadata flag.
  const flagKey: Record<SectionType, keyof NormalExtractState> = {
    "booklet-a": "bookletA",
    "grammar-cloze": "grammarCloze",
    "editing": "editing",
    "comp-cloze": "compCloze",
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
    state: updatedState,
  });
}
