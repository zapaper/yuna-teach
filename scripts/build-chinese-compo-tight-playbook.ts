// PSLE-Chinese-Compo-Tight-Playbook.docx
//
// Tighter scope per Peter's feedback:
//   (A) Only ~5 truly RE-USABLE phrases per topic, focused on the
//       sub-functions that DO transfer across scenarios:
//         - Safety:        description of accident / fright / panic
//         - Carelessness:  description of confessing / regret
//         - Both:          universal openings + closings
//       Skip scene-specific phrases — those are noise.
//   (B) Multi-topic model-essay reuse: for each of the 10 Option 1
//       model essays, list other Option 1 titles it could plausibly
//       be re-purposed for (e.g. a "safety accident" story can also
//       answer "a memorable experience" / "a lesson I learnt" / "the
//       day that changed me"). Surface the highest-reuse essays.
//
// Single Gemini call, single Word doc.

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType,
} from "docx";

const SCRIPT_DIR = __dirname;
const CACHE = path.join(SCRIPT_DIR, "compo-v2-tight-playbook.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Tight-Playbook.docx");
const MODEL = "gemini-3.1-pro-preview";
const CJK_FONT = "Microsoft YaHei";

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}

type Phrase = { cn: string; en: string };
type ReuseEssay = {
  sourceYear: string;
  sourceTitleCn: string;
  sourceTitleEn: string;
  sourceSummary: string;
  fitsTitles: Array<{ titleCn: string; titleEn: string; whyItFits: string }>;
};
type FeaturedHighlight = {
  // Verbatim substring from the model essay's body. Renderer searches
  // for this exact span in the essay text and applies the bucket's
  // colour. Spans MUST be substrings of the essay, character-for-
  // character, so the renderer's indexOf finds them.
  span: string;
  bucket: "opening" | "closing" | "accident" | "careless" | "transition";
  why: string;            // 1-line note on why this is a good re-use candidate
};
type FeaturedEssay = {
  year: string;
  titleCn: string;
  titleEn: string;
  body: string;           // full Chinese text of the model essay
  bodySummaryEn: string;  // 2-3 sentence English summary so non-Chinese parents can follow
  highlights: FeaturedHighlight[];
};
type Output = {
  universalOpenings: Phrase[];
  universalClosings: Phrase[];
  safetyAccidentDescription: Phrase[];
  carelessConfessionDescription: Phrase[];
  multiTopicEssays: ReuseEssay[];
  featuredEssays?: FeaturedEssay[];
};

async function loadEssays() {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: { year: true, compoOption1Topic: true, compoOption1Model: true },
  });
  return rows.filter(r => r.compoOption1Topic && r.compoOption1Model);
}

async function derivePlaybook(): Promise<Output> {
  try { return JSON.parse(await fs.readFile(CACHE, "utf8")) as Output; } catch { /* miss */ }

  const essays = await loadEssays();
  const bundle = essays.map(e =>
    `=== ${e.year} 题目: ${e.compoOption1Topic} ===\n${e.compoOption1Model}`
  ).join("\n\n");

  const prompt = `你是 PSLE 华文写作教练。学生希望两份**简短**的速查表，不要长篇大论。

下面是 2016-2025 年 PSLE 华文作文第一题（题目 + 范文）。每年题目格式大多是「这件事让我…」之类的具体感悟题。

${bundle}

## 任务 A — 通用短语（每类 5 句即可，不超过 5 句）

只挑出**可以跨场景重用**的句子。不要给场景化的（例如"红灯亮了"只能用在过马路；这种 SKIP）。要给那种**在任何安全事故/粗心情节中都能塞进去**的通用句。

返回 4 个桶，每桶恰好 **5 句**，每句中英对照：

1. **universalOpenings** — 通用开头（不点明具体事件，但能制造氛围/铺垫的金句）。例如：「至今我还记得那一幕…」「那是一个我永远忘不了的下午…」
2. **universalClosings** — 通用结尾 / 反思（任何「事故/粗心/教训」类故事都用得上）。例如：「经过这件事，我深深明白…」「从那以后，我再也不敢…」
3. **safetyAccidentDescription** — 描写事故、惊吓、慌乱、心跳加速的句子。例如：「我吓得浑身发抖，心跳得像要从胸口跳出来一样。」
4. **carelessConfessionDescription** — 表达「承认自己粗心 / 后悔自责」的句子。例如：「我懊悔不已，恨不得抽自己一巴掌。」

每句 EN 翻译要自然流畅。

## 任务 B — 多用途范文识别

学生想知道：**有没有几篇范文可以一稿多用**（即同一篇范文，稍作改动就能套用在好几个 Option 1 题目下）。

把上面 10 篇范文，每一篇分析它的**核心情节**，然后列出**它还能套用在哪些 Option 1 类型题目**下。常见的 Option 1 题型有：
- 这件事让我明白了 XX 的重要（XX = 合作 / 耐心 / 诚实 / 守信 / 关怀…）
- 一件让我难忘的事
- 一件让我感动的事
- 一件让我后悔的事
- 一件让我变得 XX 的事（勇敢 / 成熟 / 坚强…）
- 一件让我学到教训的事
- 一份珍贵的礼物 / 一份珍贵的友谊
- 一次难忘的经历
- 一件让别人为我感到骄傲的事
- 我做了一个正确的决定
- ...（你可以补充其他常见题）

**只保留那些 fitsTitles 至少有 3 个不同方向**的范文（即真正的「多用途」范文）。最多 4 篇就够。

返回严格 JSON（不带 markdown）：
{
  "universalOpenings": [{ "cn": "...", "en": "..." } × 5],
  "universalClosings": [{ "cn": "...", "en": "..." } × 5],
  "safetyAccidentDescription": [{ "cn": "...", "en": "..." } × 5],
  "carelessConfessionDescription": [{ "cn": "...", "en": "..." } × 5],
  "multiTopicEssays": [
    {
      "sourceYear": "2020",
      "sourceTitleCn": "这样做是自私的",
      "sourceTitleEn": "Doing so is selfish",
      "sourceSummary": "一段 30-50 字的中文情节摘要",
      "fitsTitles": [
        { "titleCn": "一件让我后悔的事", "titleEn": "Something I regret", "whyItFits": "1-2 句话说明为什么这篇范文可以改编成这道题" },
        { "titleCn": "这件事让我明白了关怀的重要", "titleEn": "This event taught me the importance of care", "whyItFits": "..." },
        { "titleCn": "这件事让我变得成熟", "titleEn": "This made me more mature", "whyItFits": "..." }
      ]
    }
  ]
}

保持精简。任务 A 严格 5 句每桶。任务 B 最多 4 篇范文。`;

  console.log("[tight-playbook] calling Gemini...");
  const res = await ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 16384 },
  });
  const parsed = JSON.parse(res.text ?? "{}") as Output;
  await fs.writeFile(CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[tight-playbook] done — ${parsed.multiTopicEssays.length} multi-topic essays`);
  return parsed;
}

// ─── docx ──────────────────────────────────────────────────────
function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text, bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color,
    font: { name: CJK_FONT, eastAsia: CJK_FONT },
  });
}
function p(text: string, opts?: { heading?: HeadingLevel; before?: number; after?: number; bold?: boolean; italics?: boolean; size?: number; color?: string; align?: typeof AlignmentType[keyof typeof AlignmentType] }) {
  return new Paragraph({
    heading: opts?.heading,
    spacing: { before: opts?.before, after: opts?.after },
    alignment: opts?.align,
    children: [t(text, { bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color })],
  });
}
function bilingualBullet(cn: string, en: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 }, spacing: { before: 60, after: 60 },
    children: [
      t(cn, { size: 24, bold: true }),
      t("  —  ", { color: "9CA3AF", size: 22 }),
      t(en, { italics: true, color: "4B5563", size: 20 }),
    ],
  });
}
function cell(content: string | TextRun[], opts?: { bold?: boolean; size?: number; width?: number; bg?: string; color?: string }) {
  const runs = typeof content === "string" ? [t(content, { bold: opts?.bold, size: opts?.size ?? 20, color: opts?.color })] : content;
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: opts?.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: "auto" } : undefined,
    children: [new Paragraph({ children: runs })],
  });
}
function tableBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
  };
}

function phraseSection(headingCn: string, headingEn: string, phrases: Phrase[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  out.push(p(headingCn, { heading: HeadingLevel.HEADING_2, before: 180, after: 30 }));
  out.push(p(headingEn, { italics: true, color: "6B7280", size: 20, after: 60 }));
  for (const ph of phrases) out.push(bilingualBullet(ph.cn, ph.en));
  return out;
}

function reuseEssaySection(e: ReuseEssay): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  out.push(new Paragraph({
    spacing: { before: 220, after: 40 },
    children: [
      t(`📖 ${e.sourceYear} · ${e.sourceTitleCn}`, { bold: true, size: 26, color: "1E40AF" }),
      t(`  —  ${e.sourceTitleEn}`, { italics: true, color: "6B7280", size: 20 }),
    ],
  }));
  out.push(p(`情节摘要: ${e.sourceSummary}`, { italics: true, color: "4B5563", size: 22, after: 80 }));
  out.push(p(`✅ 这篇范文还可以改编成以下题目：  /  Also fits these titles:`, { bold: true, size: 22, color: "047857", after: 40 }));
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell("题目  / Title", { bold: true, width: 35, bg: "D1FAE5", size: 18 }),
      cell("为什么可以套  / Why it fits", { bold: true, width: 65, bg: "D1FAE5", size: 18 }),
    ],
  });
  const rows = e.fitsTitles.map(f => new TableRow({
    children: [
      cell([
        t(f.titleCn, { bold: true, size: 22 }),
        t(`\n${f.titleEn}`, { italics: true, color: "6B7280", size: 18 }),
      ]),
      cell(f.whyItFits, { size: 22 }),
    ],
  }));
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorder(), rows: [header, ...rows] }));
  return out;
}

const FEATURED_YEARS = ["2016", "2019", "2020", "2022"];
const FEATURED_CACHE = path.join(SCRIPT_DIR, "compo-v2-tight-featured.json");

async function deriveFeaturedEssays(): Promise<FeaturedEssay[]> {
  try {
    const cached = JSON.parse(await fs.readFile(FEATURED_CACHE, "utf8")) as FeaturedEssay[];
    if (Array.isArray(cached) && cached.length === FEATURED_YEARS.length) return cached;
  } catch { /* miss */ }

  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { year: { in: FEATURED_YEARS } },
    select: { year: true, compoOption1Topic: true, compoOption1Model: true },
  });
  const byYear = new Map(rows.map(r => [r.year, r]));

  const out: FeaturedEssay[] = [];
  for (const year of FEATURED_YEARS) {
    const row = byYear.get(year);
    if (!row || !row.compoOption1Model || !row.compoOption1Topic) {
      console.warn(`[featured] skipping ${year} — missing data`);
      continue;
    }
    const body = row.compoOption1Model;
    const titleCn = row.compoOption1Topic;
    console.log(`[featured] ${year} — extracting reusable spans...`);
    const prompt = `下面是 PSLE ${year} 华文作文第一题的范文。题目：${titleCn}

范文：
${body}

请挑出**5-10 段最值得借鉴**的句子（必须**逐字**从范文里照抄）。每段标注 bucket：
- "opening" 通用开头（铺垫、回忆切入）
- "closing" 通用结尾 / 反思
- "accident" 事故 / 惊吓 / 慌乱描写
- "careless" 承认粗心 / 自责描写
- "transition" 转折 / 高潮转换的金句

外加一段 30-60 字的英文 bodySummaryEn 总结这篇范文的情节，让不懂中文的家长也能跟读。

返回严格 JSON（不带 markdown）：
{
  "year": "${year}",
  "titleCn": "${titleCn}",
  "titleEn": "1 句话英文翻译这个题目",
  "bodySummaryEn": "...",
  "highlights": [
    { "span": "...一字不差从范文摘出...", "bucket": "opening", "why": "1 行中文说明为什么这段可重用" },
    ...
  ]
}

**关键：每个 span 必须是范文里的逐字片段，不要改字、不要换标点、不要加省略号。** 因为渲染器会用 indexOf 在范文里搜索，找不到就高亮不上。`;
    const res = await ai().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 8192 },
    });
    const essay = JSON.parse(res.text ?? "{}") as FeaturedEssay;
    essay.body = body;  // overwrite — must be the canonical text we'll render
    // Drop any span Gemini hallucinated that doesn't actually appear in body.
    const before = essay.highlights?.length ?? 0;
    essay.highlights = (essay.highlights ?? []).filter(h => body.includes(h.span));
    if (essay.highlights.length < before) {
      console.warn(`[featured] ${year} — dropped ${before - essay.highlights.length} non-matching spans`);
    }
    out.push(essay);
  }
  await fs.writeFile(FEATURED_CACHE, JSON.stringify(out, null, 2));
  console.log(`[featured] done — ${out.length} essays, ${out.reduce((s, e) => s + e.highlights.length, 0)} spans total`);
  return out;
}

const BUCKET_COLOUR: Record<FeaturedHighlight["bucket"], string> = {
  opening: "fef3c7",       // amber-100
  closing: "d1fae5",       // emerald-100
  accident: "fee2e2",      // red-100
  careless: "ede9fe",      // violet-100
  transition: "dbeafe",    // blue-100
};
const BUCKET_LABEL_CN: Record<FeaturedHighlight["bucket"], string> = {
  opening: "开头", closing: "结尾", accident: "事故", careless: "粗心", transition: "转折",
};

function renderEssayWithHighlights(essay: FeaturedEssay): Paragraph[] {
  // Build a list of (start, end, bucket) intervals from the highlights.
  // For overlaps, the FIRST span wins (Gemini rarely emits overlaps,
  // and the worst case is one highlight beats another — acceptable).
  type Interval = { start: number; end: number; bucket: FeaturedHighlight["bucket"]; why: string };
  const intervals: Interval[] = [];
  for (const h of essay.highlights) {
    const idx = essay.body.indexOf(h.span);
    if (idx < 0) continue;
    // Skip if overlaps with an existing interval
    const end = idx + h.span.length;
    if (intervals.some(i => !(end <= i.start || idx >= i.end))) continue;
    intervals.push({ start: idx, end, bucket: h.bucket, why: h.why });
  }
  intervals.sort((a, b) => a.start - b.start);

  // Slice body into runs and apply per-bucket shading on highlighted runs.
  // Newline characters split paragraphs.
  const runs: { text: string; bucket?: FeaturedHighlight["bucket"] }[] = [];
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.start > cursor) runs.push({ text: essay.body.slice(cursor, iv.start) });
    runs.push({ text: essay.body.slice(iv.start, iv.end), bucket: iv.bucket });
    cursor = iv.end;
  }
  if (cursor < essay.body.length) runs.push({ text: essay.body.slice(cursor) });

  // Now split each run on newlines and emit one Paragraph per essay paragraph.
  // Within each paragraph, the run becomes a TextRun (with shading if bucket).
  const paragraphs: Paragraph[] = [];
  type PendingRun = { text: string; bucket?: FeaturedHighlight["bucket"] };
  let buffer: PendingRun[] = [];
  function flushParagraph() {
    if (buffer.length === 0) return;
    const children: TextRun[] = buffer
      .filter(r => r.text.length > 0)
      .map(r => new TextRun({
        text: r.text,
        size: 22,
        font: { name: CJK_FONT, eastAsia: CJK_FONT },
        highlight: r.bucket ? "yellow" : undefined,  // .highlight gives a built-in colour name
        bold: r.bucket ? true : undefined,
        color: r.bucket
          ? (r.bucket === "accident" ? "991B1B" : r.bucket === "careless" ? "5B21B6" : r.bucket === "opening" ? "92400E" : r.bucket === "closing" ? "047857" : "1E40AF")
          : undefined,
      }));
    paragraphs.push(new Paragraph({ spacing: { after: 120 }, children }));
    buffer = [];
  }
  for (const r of runs) {
    const lines = r.text.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      buffer.push({ text: lines[i], bucket: r.bucket });
      if (i < lines.length - 1) flushParagraph();
    }
  }
  flushParagraph();
  return paragraphs;
}

function featuredEssaySection(essay: FeaturedEssay): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  out.push(new Paragraph({
    spacing: { before: 320, after: 60 },
    children: [
      t(`📜 ${essay.year} · ${essay.titleCn}`, { bold: true, size: 28, color: "1E40AF" }),
      t(`  —  ${essay.titleEn}`, { italics: true, color: "6B7280", size: 20 }),
    ],
  }));
  out.push(p(essay.bodySummaryEn, { italics: true, color: "4B5563", size: 20, after: 100 }));

  // Legend
  out.push(new Paragraph({
    spacing: { before: 60, after: 80 },
    children: [
      t("可借鉴句标记: ", { bold: true, size: 18, color: "4B5563" }),
      t("开头 ", { highlight: "yellow", color: "92400E", size: 18 }),
      t("· ", { color: "9CA3AF", size: 18 }),
      t("结尾 ", { highlight: "yellow", color: "047857", size: 18 }),
      t("· ", { color: "9CA3AF", size: 18 }),
      t("事故 ", { highlight: "yellow", color: "991B1B", size: 18 }),
      t("· ", { color: "9CA3AF", size: 18 }),
      t("粗心 ", { highlight: "yellow", color: "5B21B6", size: 18 }),
      t("· ", { color: "9CA3AF", size: 18 }),
      t("转折", { highlight: "yellow", color: "1E40AF", size: 18 }),
    ],
  }));

  out.push(...renderEssayWithHighlights(essay));

  if (essay.highlights.length > 0) {
    out.push(p("被标记的句子 — 为什么可以借鉴", { bold: true, size: 22, color: "1E40AF", before: 120, after: 40 }));
    const rows: TableRow[] = [];
    rows.push(new TableRow({
      tableHeader: true,
      children: [
        cell("类别", { bold: true, width: 12, bg: "F3F4F6", size: 18 }),
        cell("句子", { bold: true, width: 50, bg: "F3F4F6", size: 18 }),
        cell("为什么可重用", { bold: true, width: 38, bg: "F3F4F6", size: 18 }),
      ],
    }));
    for (const h of essay.highlights) {
      rows.push(new TableRow({
        children: [
          cell(BUCKET_LABEL_CN[h.bucket], {
            bold: true, size: 20, bg: BUCKET_COLOUR[h.bucket],
            color: h.bucket === "accident" ? "991B1B" : h.bucket === "careless" ? "5B21B6" : h.bucket === "opening" ? "92400E" : h.bucket === "closing" ? "047857" : "1E40AF",
          }),
          cell(h.span, { size: 20 }),
          cell(h.why, { size: 20, color: "4B5563" }),
        ],
      }));
    }
    out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorder(), rows }));
  }
  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  if (force) {
    for (const f of [CACHE, FEATURED_CACHE]) {
      try { await fs.unlink(f); console.log(`[force] removed ${path.basename(f)}`); } catch { /* miss */ }
    }
  }
  const data = await derivePlaybook();
  const featured = await deriveFeaturedEssays();
  data.featuredEssays = featured;

  const children: (Paragraph | Table)[] = [];
  children.push(p("华文作文「精简速查表」", { heading: HeadingLevel.TITLE, align: AlignmentType.CENTER, after: 100 }));
  children.push(p("PSLE Chinese Composition — Tight Playbook (Safety + Carelessness)", { heading: HeadingLevel.HEADING_2, align: AlignmentType.CENTER, color: "4B5563", after: 200 }));
  children.push(p("两份内容：(1) 4 桶共 20 句通用短语；(2) 几篇可一稿多用的范文", { italics: true, color: "6B7280", align: AlignmentType.CENTER, size: 20, after: 400 }));

  // PART A
  children.push(p("Part A · 20 句通用短语  ·  20 Re-usable Phrases", { heading: HeadingLevel.HEADING_1, before: 200, after: 80 }));
  children.push(p("只挑跨场景能用的句子。每类 5 句，背熟就能套。", { italics: true, color: "4B5563", size: 22, after: 120 }));

  children.push(...phraseSection("① 通用开头", "Universal openings — set the mood without naming the event", data.universalOpenings));
  children.push(...phraseSection("② 通用结尾 / 反思", "Universal closings / reflection — wraps any 'lesson learnt' story", data.universalClosings));
  children.push(...phraseSection("③ 事故 / 惊吓 / 慌乱 描写", "Accident / fright / panic — for ANY safety story", data.safetyAccidentDescription));
  children.push(...phraseSection("④ 承认粗心 / 自责描写", "Confessing to carelessness / regret — for ANY careless-mistake story", data.carelessConfessionDescription));

  // PART B
  children.push(p("Part B · 一稿多用的范文  ·  Multi-purpose Model Essays", { heading: HeadingLevel.HEADING_1, before: 400, after: 80 }));
  children.push(p("以下范文「情节」泛用度高 — 把名字/地点/物品稍换一下，就能套到几个不同题目上。", { italics: true, color: "4B5563", size: 22, after: 120 }));
  for (const e of data.multiTopicEssays) children.push(...reuseEssaySection(e));

  // PART C — featured essays with highlighted reusable spans
  if (data.featuredEssays && data.featuredEssays.length > 0) {
    children.push(p("Part C · 范文全文 + 重点句标注  ·  Featured Model Essays with Highlights",
      { heading: HeadingLevel.HEADING_1, before: 400, after: 80 }));
    children.push(p("以下是 2016、2019、2020、2022 年范文全文。被颜色标注的句子是可以「直接背、跨题套用」的金句，颜色对应 Part A 的 4 个桶。",
      { italics: true, color: "4B5563", size: 22, after: 120 }));
    for (const e of data.featuredEssays) children.push(...featuredEssaySection(e));
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
