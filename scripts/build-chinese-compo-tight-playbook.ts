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
type Output = {
  universalOpenings: Phrase[];
  universalClosings: Phrase[];
  safetyAccidentDescription: Phrase[];
  carelessConfessionDescription: Phrase[];
  multiTopicEssays: ReuseEssay[];
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

async function main() {
  const force = process.argv.includes("--force");
  if (force) { try { await fs.unlink(CACHE); console.log("[force] removed cache"); } catch { /* miss */ } }
  const data = await derivePlaybook();

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

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
