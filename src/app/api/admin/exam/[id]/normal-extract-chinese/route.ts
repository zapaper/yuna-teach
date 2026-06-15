// Per-section "Normal Extract" pipeline for Chinese papers. Mirrors
// the English route's structure; specific to Chinese section types.
//
// Section heuristics:
//   - yuwen-mcq (语文应用 MCQ): sequential MCQ stack, full-width crops.
//   - duanwen (短文填空): like grammar cloze but wider y range, since
//     Chinese passage wrap can put a single blank across multiple
//     visual lines.
//   - comp-mcq (阅读理解 MCQ): sequential MCQ on a passage.
//   - duihua (完成对话): dialogue; crop the WHOLE horizontal line
//     where the Q-number sits (editing-style x-strip).
//   - comp-oeq (阅读理解 OEQ): sequential, full-width crop.
//
// Per-section completion: metadata.normalExtractChinese.
//   { yuwenMcq?: true, duanwen?: true, compMcq?: true, duihua?: true,
//     compOeq?: true, lastRunAt?: string }

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

type SectionType = "yuwen-mcq" | "duanwen" | "comp-mcq" | "duihua" | "comp-oeq";
type SecMeta = { label: string; startIndex: number; endIndex: number; passage?: string };
type NormalExtractState = {
  yuwenMcq?: boolean;
  duanwen?: boolean;
  compMcq?: boolean;
  duihua?: boolean;
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

// Patterns matched against prod's metadata.chineseSections / per-question
// syllabusTopic labels. Topic names use Chinese characters; we match by
// substring presence on the actual Chinese tokens.
const SECTION_LABELS: Record<SectionType, RegExp[]> = {
  "yuwen-mcq": [/语文应用/, /语文运用/],
  "duanwen": [/短文填空/],
  "comp-mcq": [/阅读理解(?!\s*OEQ).*MCQ/i, /^阅读理解\s*(?:[AB])?$/i, /阅读理解\s*[AB]\b(?!\s*OEQ)/i],
  "duihua": [/完成对话/, /对话填空/],
  "comp-oeq": [/阅读理解\s*(?:[AB]\s*)?OEQ/i, /阅读理解\s*OEQ/i],
};

// P4 papers have a 词语搭配 section that looks like a phrase-bank
// matching exercise: a table of numbered phrases at the top, then
// numbered prompt-phrases each followed by a blank where the student
// writes the matching number. The crop shape is identical to 完成对话
// (single-row horizontal strip per Q), so we route P4 词语搭配 through
// the duihua extractor. Gated to P4 because P5/P6 don't carry this
// exact format and we don't want a stray 词语搭配 label on a higher
// level paper to pick up the wrong crop shape.
function isP4(level: string | null | undefined): boolean {
  return (level ?? "").toLowerCase().includes("primary 4");
}

function sectionMatches(label: string, type: SectionType, level: string | null | undefined): boolean {
  if (SECTION_LABELS[type].some(re => re.test(label))) return true;
  if (type === "duihua" && isP4(level) && /词语搭配/.test(label)) return true;
  return false;
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
  const isClozeSection = /cloze/i.test(sectionHint);
  const clozeGuidance = isClozeSection ? `

CLOZE INLINE QUESTION NUMBERS: this is a cloze section. Each question number is printed INLINE WITHIN the passage text, in parentheses like "(11)", "(12)", placed IMMEDIATELY BEFORE or AFTER a blank line. The blank is a horizontal underline where the student writes the chosen word's label. These INLINE (N) markers ARE the question numbers — report each one. The general rule "NOT a reference inside text" does NOT apply here; in a cloze section every (N) inside the passage IS a question marker, and you must report all of them.` : "";

  const prompt = `You are reading page ${pageIndex + 1} of a Singapore PSLE Chinese (华文) paper. The section on this page is: ${sectionHint}.

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
}): Promise<{ detectionsByPage: Map<number, Detection[]>; warnings: string[] }> {
  const { paperId, sectionQuestionIds, allQuestions, sectionHint, pageRange, pageCount } = args;
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
    const detections = await findQuestionPositionsOnPage(pageBytes, pageIdx, expectedNums, sectionHint);
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
}): Promise<RunOutput> {
  const { sections, allQuestions } = args;
  const sectionQuestionIds = collectSectionQuestionIds(sections, allQuestions);

  if (sectionQuestionIds.size === 0) {
    return { updated: 0, warnings: ["No questions found in metadata.chineseSections for this section."], perSection: [], bounds: [] };
  }

  const { detectionsByPage, warnings } = await detectAcrossSectionPages({
    paperId: args.paperId,
    sectionQuestionIds,
    allQuestions,
    sectionHint: args.sectionHint,
    pageCount: args.pageCount,
    pageRange: args.pageRange,
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
//
// Multi-line override (used by 短文填空): when xStartZeroIfMultiLine
// is true, compare each Q's yPctTop against the next Q on the same
// page. If the gap exceeds ONE_LINE_PCT (~one row of text), the
// answer has wrapped to the next line which starts at the left
// margin — so xStart is pinned to 0 to include that wrap, and
// yBottomDelta swaps to yBottomDeltaMultiLine so the wider crop
// captures the wrap row too. Single-line Qs stay at the (tight)
// default yBottomDelta and keep their indented xStart.
// ─── P4 词语搭配 augmentation ────────────────────────────────────────────────
// 词语搭配 ("word-collocation matching") prints a numbered phrase bank
// at the top of the section (1-8) and 4-6 prompt rows like
// "11. 摇摆 (11) ____" / "12. (12) ____ 规则" beneath it. Default Chinese
// OCR drops both pieces:
//   - per-Q stems come back as "摇摆 ( )" / "( ) 规则" (the printed Q-num
//     inside the parens vanishes, no blank marker)
//   - the section-top word table never lands in metadata
// → kid sees a blank stem with nothing to pick from.
//
// Fix path: re-OCR the section page with a 词语搭配-specific prompt,
// build a synthetic markdown passage that the existing grammar-cloze
// renderer (PassageWithInputs) already knows how to lay out:
//   · digit row + phrase row (2-row word bank table — same shape the
//     PSLE 2024/2025 完成对话 word bank uses; linkedLabels pre-pass
//     auto-strikes used phrases for free)
//   · each Q on its own line with a **(qNum)____** marker that becomes
//     a labelled input.
//
// Limited to P4 only — P5/P6 don't use this layout and accidentally
// rewriting their 完成对话 sections would be destructive.

type CiyuExtract = {
  wordBank: Array<{ num: number; phrase: string }>;
  questions: Array<{ qNum: number; stemBefore: string; stemAfter: string }>;
};

async function extractCiyuP4Content(
  pageBytes: Buffer,
  pageIndex: number,
  expectedQNums: number[],
): Promise<CiyuExtract | null> {
  const prompt = `You are reading page ${pageIndex + 1} of a Singapore Primary 4 Chinese (华文) paper. The section on this page is 词语搭配 — a word-collocation matching exercise.

LAYOUT:
- Top of the section: a TABLE of 8 numbered Chinese phrases labelled (1) through (8). Example: (1) 家长 (2) 插队 (3) 身体 (4) 穷人 (5) 挥动 (6) 遵守 (7) 摇摆 (8) 球拍.
- Below the table: 4-6 short prompt rows. Each row has a printed question number in parentheses, an empty bracket where the student writes the matching phrase number, and a prompt phrase. The empty bracket can appear AFTER the prompt phrase ("摇摆 (11) ___") OR BEFORE it ("(12) ___ 规则"). The "(11)" / "(12)" inside the parentheses is the QUESTION NUMBER, NOT the answer.

EXTRACT:
1. The 8 phrases in the word bank, in order, with their bank-number 1-8.
2. For each prompt row whose question number is in this list: ${expectedQNums.join(", ")}. Report:
   - "qNum": the question number (e.g. 11)
   - "stemBefore": the Chinese text BEFORE the (qNum)____ blank, trimmed (often empty)
   - "stemAfter": the Chinese text AFTER the (qNum)____ blank, trimmed (often empty)

Output STRICTLY this JSON shape — no markdown, no commentary:
{
  "wordBank": [{ "num": 1, "phrase": "家长" }, { "num": 2, "phrase": "插队" }],
  "questions": [
    { "qNum": 11, "stemBefore": "摇摆", "stemAfter": "" },
    { "qNum": 12, "stemBefore": "", "stemAfter": "规则" }
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

  try {
    const parsed = JSON.parse(resp.text ?? "{}") as {
      wordBank?: Array<{ num?: unknown; phrase?: unknown }>;
      questions?: Array<{ qNum?: unknown; stemBefore?: unknown; stemAfter?: unknown }>;
    };
    const wordBank: CiyuExtract["wordBank"] = [];
    for (const w of parsed.wordBank ?? []) {
      const num = Number(w.num);
      const phrase = String(w.phrase ?? "").trim();
      if (Number.isFinite(num) && phrase) wordBank.push({ num, phrase });
    }
    const questions: CiyuExtract["questions"] = [];
    for (const q of parsed.questions ?? []) {
      const qNum = Number(q.qNum);
      if (!Number.isFinite(qNum)) continue;
      questions.push({
        qNum,
        stemBefore: String(q.stemBefore ?? "").trim(),
        stemAfter: String(q.stemAfter ?? "").trim(),
      });
    }
    return { wordBank, questions };
  } catch (err) {
    console.error(`[normal-extract] 词语搭配 parse failed for page ${pageIndex}:`, err);
    return null;
  }
}

// Build the synthetic passage that PassageWithInputs renders:
//   row 1: "| 1 | 2 | 3 | … | 8 |"  (digit labels)
//   sep:   "|---|---|---|---|---|---|---|---|"
//   row 2: "| 家长 | 插队 | … |"      (phrase row, auto-linked to digits)
//   blank line
//   "11. 摇摆 **(11)____**"
//   "12. **(12)____** 规则"
//   ...
function buildCiyuPassage(extract: CiyuExtract): string {
  const lines: string[] = [];
  if (extract.wordBank.length > 0) {
    const sorted = [...extract.wordBank].sort((a, b) => a.num - b.num);
    const nums = sorted.map(w => String(w.num));
    const phrases = sorted.map(w => w.phrase);
    lines.push(`| ${nums.join(" | ")} |`);
    lines.push(`|${sorted.map(() => "---").join("|")}|`);
    lines.push(`| ${phrases.join(" | ")} |`);
    lines.push("");
  }
  for (const q of extract.questions) {
    const blank = `**(${q.qNum})________**`;
    const before = q.stemBefore.trim();
    const after = q.stemAfter.trim();
    const body = [before, blank, after].filter(Boolean).join(" ");
    lines.push(`${q.qNum}. ${body}`);
  }
  return lines.join("\n");
}

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
  xStartZeroIfMultiLine?: boolean;
  yBottomDeltaMultiLine?: number;
}): Promise<RunOutput> {
  const { sections, allQuestions, xLeftDelta, xRightDelta, yTopDelta, yBottomDelta, xStartZeroIfMultiLine, yBottomDeltaMultiLine } = args;
  const sectionQuestionIds = collectSectionQuestionIds(sections, allQuestions);

  if (sectionQuestionIds.size === 0) {
    return { updated: 0, warnings: ["No questions found in metadata.chineseSections for this section."], perSection: [], bounds: [] };
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

  // A single-line Q on PSLE Chinese ≈ 4% gap to the next Q (one row
  // of text). A 2-line wrap ≈ 8% gap. Threshold at 5.5% sits cleanly
  // between them. Anything beyond means the current Q wraps to the
  // next line which starts at the left margin.
  const ONE_LINE_PCT = 5.5;

  let updated = 0;
  const perSection: Array<{ label: string; updated: number }> = [];
  const bounds: QuestionBound[] = [];

  for (const sec of sections) {
    let sectionUpdated = 0;

    // Build a same-page sorted list once per section so multi-line
    // detection can look up each Q's successor without re-sorting.
    type DetEntry = { qq: QuestionRow; d: { pageIdx: number; yPctTop: number; xPctLeft: number } };
    const samePageSortedByPage = new Map<number, DetEntry[]>();
    if (xStartZeroIfMultiLine) {
      for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
        const qq = allQuestions[qi];
        const d = detByNum.get(qq.questionNum) ?? detByNum.get(normalizeQuestionNum(qq.questionNum));
        if (!d) continue;
        const arr = samePageSortedByPage.get(d.pageIdx) ?? [];
        arr.push({ qq, d });
        samePageSortedByPage.set(d.pageIdx, arr);
      }
      for (const arr of samePageSortedByPage.values()) arr.sort((a, b) => a.d.yPctTop - b.d.yPctTop);
    }

    for (let qi = sec.startIndex; qi <= sec.endIndex && qi < allQuestions.length; qi++) {
      const q = allQuestions[qi];
      const det = detByNum.get(q.questionNum) ?? detByNum.get(normalizeQuestionNum(q.questionNum));
      if (!det) {
        warnings.push(`Q${q.questionNum} not detected by Gemini on any scanned page.`);
        bounds.push({ id: q.id, questionNum: q.questionNum, pageIndex: q.pageIndex, yStartPct: null, yEndPct: null, xStartPct: null, xEndPct: null, status: "not_detected" });
        continue;
      }
      const yStart = clampPct(det.yPctTop - yTopDelta);
      let xStart = clampPct(det.xPctLeft - xLeftDelta);
      const xEnd = clampPct(det.xPctLeft + xRightDelta);

      // Multi-line override: if the next Q on this page sits more
      // than one line below, the current Q's answer wraps and the
      // wrap line begins at the left margin (x=0). The bottom of
      // the crop also extends so the wrap row is included.
      let effectiveYBottomDelta = yBottomDelta;
      if (xStartZeroIfMultiLine) {
        const arr = samePageSortedByPage.get(det.pageIdx);
        if (arr) {
          const idx = arr.findIndex(e => e.qq.id === q.id);
          const nextY = idx >= 0 && idx + 1 < arr.length ? arr[idx + 1].d.yPctTop : null;
          const isMultiLine = nextY === null
            ? true // last Q on page — assume multi-line so we don't clip the answer
            : (nextY - det.yPctTop) > ONE_LINE_PCT;
          if (isMultiLine) {
            xStart = 0;
            if (yBottomDeltaMultiLine !== undefined) effectiveYBottomDelta = yBottomDeltaMultiLine;
          }
        }
      }
      const yEnd = clampPct(det.yPctTop + effectiveYBottomDelta);

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
    return NextResponse.json({ error: "Body { sectionType } must be one of: yuwen-mcq, duanwen, comp-mcq, duihua, comp-oeq" }, { status: 400 });
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
  const subjRaw = paper.subject ?? "";
  const subjLower = subjRaw.toLowerCase();
  const isChinese = subjLower.includes("chinese") || subjRaw.includes("华文") || subjRaw.includes("中文") || subjRaw.includes("华语");
  if (!isChinese) {
    return NextResponse.json({ error: "This route is Chinese-only. Use the English / math / science pipelines for other subjects." }, { status: 400 });
  }
  const paperLevel = paper.level;

  type PapersEntry = { label: string; questionsStartPage?: number; expectedQuestions?: number };
  const meta = (paper.metadata ?? {}) as {
    chineseSections?: SecMeta[];
    normalExtractChinese?: NormalExtractState;
    papers?: PapersEntry[];
  };
  let sections: SecMeta[] = (meta.chineseSections ?? []).filter(s => sectionMatches(s.label, sectionType, paperLevel));
  console.log(`[normal-extract] sectionType=${sectionType}, chineseSections matched: ${sections.length}`);

  // Fallback 1: per-syllabusTopic groupings. Clean Extract tags every
  // question with its section name (e.g. "Grammar Cloze", "Vocabulary
  // MCQ", "Comprehension Open Ended") even on PSLE / school papers
  // that don't carry chineseSections metadata. Group consecutive
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
      .filter(g => sectionMatches(g.topic, sectionType, paperLevel))
      .map(g => ({ label: g.topic, startIndex: g.startIndex, endIndex: g.endIndex }));
    console.log(`[normal-extract] topic fallback → ${sections.length} sections: ${sections.map(s => `"${s.label}"[${s.startIndex}..${s.endIndex}]`).join(", ")}`);
  }

  // (Chinese papers don't have a metadata.papers-based booklet fallback —
  // chineseSections + syllabusTopic groupings cover every section type
  // this route handles.)

  if (sections.length === 0) {
    const availableTopics = [...new Set(paper.questions.map(q => q.syllabusTopic).filter(Boolean))];
    const detail = `No matching section for sectionType="${sectionType}". Checked metadata.chineseSections, metadata.papers, and per-question syllabusTopic — nothing matched.`;
    return NextResponse.json({
      error: detail,
      availableSectionLabels: (meta.chineseSections ?? []).map(s => s.label),
      availablePapers: (meta.papers ?? []).map(p => ({ label: p.label, expectedQuestions: p.expectedQuestions, questionsStartPage: p.questionsStartPage })),
      availableSyllabusTopics: availableTopics,
    }, { status: 400 });
  }

  let result: RunOutput;
  switch (sectionType) {
    case "yuwen-mcq":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "语文应用 MCQ — sequential MCQ stack, each question's stem + 4 options stacked vertically",
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "comp-mcq":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "阅读理解 MCQ — sequential MCQ on a Chinese passage, stem + 4 options per question",
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "comp-oeq":
      result = await extractSequential({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "阅读理解 OEQ — open-ended Chinese comprehension questions, sequential numbering",
        pageCount: paper.pageCount ?? undefined,
      });
      break;
    case "duanwen":
      // 短文填空 — Chinese passage with numbered blanks. Default
      // crop is one row tall (yBottomDelta=3 covers the Q-number's
      // own row at ~4% line height). If the next Q on the same
      // page is > one line away, the answer has wrapped; the
      // override pins xStart=0 (wrap row starts at left margin)
      // and bumps yBottomDelta to 7 so the wrap row is included.
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: "短文填空 — Chinese passage with numbered blanks. Word bank labels 一/二/.../八 (or 1-8) selected to fill each blank.",
        xLeftDelta: 12, xRightDelta: 90, yTopDelta: 1, yBottomDelta: 2,
        pageCount: paper.pageCount ?? undefined,
        xStartZeroIfMultiLine: true,
        yBottomDeltaMultiLine: 6,
      });
      break;
    case "duihua": {
      // 完成对话 — extract ONLY the row containing the Q-number.
      // Each numbered blank sits in a single speaker line; no need
      // to extend to the next row (unlike 短文填空 where the answer
      // can wrap). Wide horizontal strip, single-line height.
      //
      // P4 词语搭配 reuses this extractor: questions are numbered
      // phrase-prompts each followed by a blank where the student
      // writes the number of the matching phrase from the table at
      // the top of the section. Crop shape is identical to 完成对话
      // (single row per Q). Hint is tweaked when the matched sections
      // are 词语搭配 so Gemini doesn't get confused looking for
      // dialogue speakers.
      const isWordMatching = sections.some(s => /词语搭配/.test(s.label));
      const hint = isWordMatching
        ? "词语搭配 — word-collocation matching. A table of numbered phrases sits at the top of the section; each numbered question is a phrase prompt followed by a blank where the student writes the matching number. Crop just the row containing the Q-number (the prompt + its blank), not the phrase table."
        : "完成对话 — dialogue completion. Each numbered blank sits inside one speaker line; crop just that row.";
      result = await extractAnchoredCrop({
        paperId: paper.id,
        sections,
        allQuestions: paper.questions,
        sectionHint: hint,
        xLeftDelta: 12, xRightDelta: 90, yTopDelta: 1.5, yBottomDelta: 3,
        pageCount: paper.pageCount ?? undefined,
      });
      // P4 词语搭配 augmentation: build the synthetic word-bank + blank-
      // marker passage and write transcribedStems with the printed Q-num
      // inside the parens. Per-Q crops above only cover the row image;
      // this pass is what makes the section actually playable.
      if (isP4(paperLevel)) {
        const ciyuSections = sections.filter(s => /词语搭配/.test(s.label));
        for (const sec of ciyuSections) {
          const secQs = paper.questions.slice(sec.startIndex, sec.endIndex + 1);
          const firstWithPage = secQs.find(q => q.pageIndex != null);
          const pageIdx = firstWithPage?.pageIndex ?? 0;
          const pagePath = path.join(PAGES_DIR, paper.id, `page_${pageIdx}.jpg`);
          let pageBytes: Buffer;
          try {
            pageBytes = await fs.readFile(pagePath);
          } catch {
            result.warnings.push(`词语搭配 augmentation: page_${pageIdx}.jpg not found on disk`);
            continue;
          }
          const expectedNums = secQs.map(q => parseInt(q.questionNum, 10)).filter(n => Number.isFinite(n));
          const extract = await extractCiyuP4Content(pageBytes, pageIdx, expectedNums);
          if (!extract) {
            result.warnings.push(`词语搭配 augmentation: Gemini extract failed on page ${pageIdx}`);
            continue;
          }
          const passage = buildCiyuPassage(extract);
          // Update meta.chineseSections in place — the final
          // examPaper.update at the bottom of POST persists it.
          const srcSections = meta.chineseSections ?? [];
          for (let i = 0; i < srcSections.length; i++) {
            if (srcSections[i].label === sec.label) {
              srcSections[i] = { ...srcSections[i], passage };
            }
          }
          meta.chineseSections = srcSections;
          // Update per-Q transcribedStem so the marker / printable
          // route can show "摇摆 (11) ____" instead of "摇摆 ( )".
          const byNum = new Map(extract.questions.map(q => [q.qNum, q]));
          for (const q of secQs) {
            const n = parseInt(q.questionNum, 10);
            const e = byNum.get(n);
            if (!e) continue;
            const stem = [e.stemBefore, `(${n}) ____`, e.stemAfter].filter(Boolean).join(" ");
            await prisma.examQuestion.update({
              where: { id: q.id },
              data: { transcribedStem: stem },
            });
          }
          console.log(`[normal-extract] 词语搭配 augment: section "${sec.label}" → ${extract.wordBank.length} phrases, ${extract.questions.length} Qs`);
        }
      }
      break;
    }
  }

  // Map sectionType -> the corresponding metadata flag.
  const flagKey: Record<SectionType, keyof NormalExtractState> = {
    "yuwen-mcq": "yuwenMcq",
    "duanwen": "duanwen",
    "comp-mcq": "compMcq",
    "duihua": "duihua",
    "comp-oeq": "compOeq",
  };
  const updatedState: NormalExtractState = {
    ...(meta.normalExtractChinese ?? {}),
    [flagKey[sectionType]]: result.updated > 0,
    lastRunAt: new Date().toISOString(),
  };
  await prisma.examPaper.update({
    where: { id: paper.id },
    data: {
      metadata: { ...meta, normalExtractChinese: updatedState } as never,
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
    return NextResponse.json({ error: "Query ?sectionType= must be one of: yuwen-mcq, duanwen, comp-mcq, duihua, comp-oeq" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, subject: true, level: true, metadata: true,
      questions: {
        select: { id: true, questionNum: true, pageIndex: true, orderIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true, syllabusTopic: true },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  const subjRawG = paper.subject ?? "";
  const subjLowerG = subjRawG.toLowerCase();
  const isChineseG = subjLowerG.includes("chinese") || subjRawG.includes("华文") || subjRawG.includes("中文") || subjRawG.includes("华语");
  if (!isChineseG) {
    return NextResponse.json({ error: "This route is Chinese-only." }, { status: 400 });
  }
  const paperLevelG = paper.level;

  type PapersEntry = { label: string; questionsStartPage?: number; expectedQuestions?: number };
  const meta = (paper.metadata ?? {}) as {
    chineseSections?: SecMeta[];
    papers?: PapersEntry[];
  };
  let sections: SecMeta[] = (meta.chineseSections ?? []).filter(s => sectionMatches(s.label, sectionType, paperLevelG));

  // Fallback: derive sections from question.syllabusTopic groupings.
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
      .filter(g => sectionMatches(g.topic, sectionType, paperLevelG))
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
