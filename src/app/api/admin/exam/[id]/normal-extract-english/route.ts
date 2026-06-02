// Per-section "Normal Extract" pipeline for English papers — produces
// per-question bounding boxes (pageIndex / yStartPct / yEndPct) so the
// paper can be rendered as a PDF-format quiz instead of the typed
// quiz-format that English papers fall back to today.
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
// Each section type has its own boundary heuristic. Booklet A (the
// sequential MCQ stack at the start of the paper) is the first one
// implemented end-to-end. Booklet B sections (Grammar Cloze inline,
// Editing, Comp Cloze, Comp OEQ) are stubbed and return 501 until
// their per-section logic is wired up with visual review crops.

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

const SECTION_LABELS: Record<SectionType, RegExp[]> = {
  // Booklet A = the four MCQ sections at the start of the paper.
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

// Ask Gemini to find every visible question number on a page and report
// its top-edge y-percent. We then derive yStartPct + yEndPct in code.
async function findQuestionNumbersOnPage(
  pageBytes: Buffer,
  pageIndex: number,
  expectedQuestionNums: string[],
): Promise<{ questionNum: string; yPctTop: number }[]> {
  const prompt = `You are reading page ${pageIndex + 1} of a Singapore PSLE English Booklet A.

The page contains numbered multiple-choice questions. Identify EVERY question number that is the START of a question on this page (a numbered question stem, NOT just a reference inside text or a page footer).

For each one, report:
- "questionNum": the bare number as it appears on the page (e.g. "1", "5", "12")
- "yPctTop": vertical position of the top edge of the question stem, as a percentage of the page height from the top (0 = very top, 100 = very bottom). Read the position of the question NUMBER's top edge, not the printed answer or option list.

Expected question numbers in this paper: ${expectedQuestionNums.join(", ")}. Match the printed number against this list and IGNORE any number on the page that isn't in the expected list (page numbers, etc.).

Output STRICTLY this JSON shape — no markdown, no commentary:
{
  "questions": [
    { "questionNum": "1", "yPctTop": 12.5 },
    { "questionNum": "2", "yPctTop": 22.0 }
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
    const parsed = JSON.parse(text) as { questions?: Array<{ questionNum?: unknown; yPctTop?: unknown }> };
    const out: { questionNum: string; yPctTop: number }[] = [];
    for (const q of parsed.questions ?? []) {
      const num = String(q.questionNum ?? "").trim();
      const y = Number(q.yPctTop);
      if (!num || !Number.isFinite(y)) continue;
      out.push({ questionNum: num, yPctTop: Math.max(0, Math.min(100, y)) });
    }
    return out;
  } catch (err) {
    console.error(`[normal-extract] parse failed for page ${pageIndex}:`, err);
    return [];
  }
}

// Booklet A: sequential MCQ stack. Walk pages in section order, ask
// Gemini per page for question-number positions, then derive boundaries
// (each question's yEndPct is the next question's yStartPct on the
// same page; the last question on a page goes to 100%).
async function extractBookletA(args: {
  paperId: string;
  sections: SecMeta[];
  allQuestions: { id: string; questionNum: string; pageIndex: number | null }[];
  pageCount: number;
}): Promise<{ updated: number; warnings: string[]; perSection: Array<{ label: string; updated: number }> }> {
  const { paperId, sections, allQuestions } = args;
  const warnings: string[] = [];
  const perSection: Array<{ label: string; updated: number }> = [];
  let updated = 0;

  // Build the list of expected question numbers for matching.
  const expectedNums = new Set(allQuestions.map(q => q.questionNum));
  const qByNum = new Map<string, typeof allQuestions[number]>();
  for (const q of allQuestions) qByNum.set(q.questionNum, q);

  // Determine which pages cover Booklet A. Use the questions' stored
  // pageIndex when present; otherwise walk every page until the first
  // non-Booklet-A label.
  const sectionQuestionIds = new Set<string>();
  for (const sec of sections) {
    for (let i = sec.startIndex; i <= sec.endIndex && i < allQuestions.length; i++) {
      sectionQuestionIds.add(allQuestions[i].id);
    }
  }
  const sectionPages = new Set<number>();
  for (const q of allQuestions) {
    if (sectionQuestionIds.has(q.id) && q.pageIndex != null) sectionPages.add(q.pageIndex);
  }

  if (sectionPages.size === 0) {
    warnings.push("No Booklet A pages found via question.pageIndex — has the paper been through clean-extract yet?");
    return { updated: 0, warnings, perSection };
  }

  const pagesSorted = [...sectionPages].sort((a, b) => a - b);
  const detectionsByPage = new Map<number, { questionNum: string; yPctTop: number }[]>();
  for (const pageIdx of pagesSorted) {
    const pagePath = path.join(PAGES_DIR, paperId, `page_${pageIdx}.jpg`);
    let pageBytes: Buffer;
    try {
      pageBytes = await fs.readFile(pagePath);
    } catch {
      warnings.push(`Page image not found on disk: page_${pageIdx}.jpg`);
      continue;
    }
    const onlyOurNums = [...sectionQuestionIds].map(id => allQuestions.find(q => q.id === id)?.questionNum).filter(Boolean) as string[];
    const detections = await findQuestionNumbersOnPage(pageBytes, pageIdx, onlyOurNums);
    detectionsByPage.set(pageIdx, detections);
  }

  // Build updates per question. Within a page, sort detections by
  // yPctTop ascending. yEndPct = next detection's yPctTop (or 100% if
  // this is the last detection on the page).
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
        data: { yStartPct: yStart, yEndPct: yEnd },
      });
      sectionUpdated++;
      updated++;
    }
    perSection.push({ label: sec.label, updated: sectionUpdated });
  }

  // Ensure expectedNums is touched somewhere so eslint doesn't flag it
  // when Booklet B handlers eventually use it too.
  void expectedNums;

  return { updated, warnings, perSection };
}

// Stub Booklet B handlers — return 501 with a hint so the UI can show
// "coming soon" without hiding the buttons.
function bookletBStub(sectionType: SectionType): { error: string; sectionType: SectionType } {
  return {
    error: `Normal extract for "${sectionType}" is not yet implemented. Coming in the next iteration once the crop heuristic is tuned.`,
    sectionType,
  };
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

  if (sectionType !== "booklet-a") {
    const stub = bookletBStub(sectionType);
    return NextResponse.json(stub, { status: 501 });
  }

  // Booklet A — full implementation.
  const result = await extractBookletA({
    paperId: paper.id,
    sections,
    allQuestions: paper.questions,
    pageCount: paper.pageCount,
  });

  // Update metadata.normalExtractEnglish flag for the section type.
  const updatedState: NormalExtractState = {
    ...(meta.normalExtractEnglish ?? {}),
    bookletA: result.updated > 0,
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
