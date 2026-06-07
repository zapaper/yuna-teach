// Build PSLE-Chinese-Compo-Analysis.docx from the cached Gemini
// outputs (compo-stage1/2/3-*.json) + the DB topic data. Run after
// analyze-compo-themes.ts has produced the caches. Uses Microsoft
// YaHei as the default font for proper CJK rendering in Word.

import { promises as fs } from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
} from "docx";
import { prisma } from "../src/lib/db";

const SCRIPT_DIR = __dirname;
const STAGE1_CACHE = path.join(SCRIPT_DIR, "compo-stage1-interpretations.json");
const STAGE2_CACHE = path.join(SCRIPT_DIR, "compo-stage2-themes.json");
const STAGE3_CACHE = path.join(SCRIPT_DIR, "compo-stage3-phrases.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Analysis.docx");

type Interpretation = { year: string; option2Scene: string; option2StoryHint: string };
type Theme = { name: string; description: string; yearsAppeared: Array<{ year: string; option: 1 | 2; note: string }>; frequency: number };
type Themes = { themes: Theme[]; overview: string };
type PhrasesBucket = { opening: string[]; emotion: string[]; description: string[]; climax: string[]; conclusion: string[] };
type ThemePhrases = { themeName: string; phrases: PhrasesBucket; notes: string };

// CJK font: Microsoft YaHei has near-universal Windows availability
// and Word's font-substitution falls back to PingFang on Mac. Setting
// it via TextRun.font ensures Chinese characters don't render in a
// default Latin font (which would show as boxes / shape-only).
const CJK_FONT = "Microsoft YaHei";

function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text,
    bold: opts?.bold,
    italics: opts?.italics,
    size: opts?.size,
    color: opts?.color,
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

function bullet(text: string, opts?: { bold?: boolean; size?: number }) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 40, after: 40 },
    children: [t(text, opts)],
  });
}

function thinCell(content: string, opts?: { bold?: boolean; width?: number }) {
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [t(content, { bold: opts?.bold, size: 20 })],
      }),
    ],
  });
}

function makeTable(headers: string[], rows: string[][], widths?: number[]) {
  const cols = headers.length;
  const widthArr = widths ?? new Array(cols).fill(Math.floor(100 / cols));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) => thinCell(h, { bold: true, width: widthArr[i] })),
      }),
      ...rows.map(r => new TableRow({
        children: r.map((c, i) => thinCell(c, { width: widthArr[i] })),
      })),
    ],
  });
}

async function main() {
  const interps = JSON.parse(await fs.readFile(STAGE1_CACHE, "utf8")) as Interpretation[];
  const themes = JSON.parse(await fs.readFile(STAGE2_CACHE, "utf8")) as Themes;
  const phrases = JSON.parse(await fs.readFile(STAGE3_CACHE, "utf8")) as ThemePhrases[];

  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: { year: true, compoOption1Topic: true, compoOption2: true },
  });
  const interpByYear = new Map(interps.map(i => [i.year, i]));
  const phraseByTheme = new Map(phrases.map(p => [p.themeName, p]));

  const children: (Paragraph | Table)[] = [];

  // ── Title ──
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 100 },
    children: [t("PSLE 华文作文 10 年主题与高分短语分析", { bold: true, size: 40 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [t("（2016 – 2025）", { italics: true, size: 24, color: "666666" })],
  }));
  children.push(p(
    "基于 10 年 PSLE 华文试卷一（命题作文 + 看图作文）的题目、图片场景解读、与官方范文，由 Gemini 3.1-pro 进行跨年度主题归纳与短语挖掘。专为 P6 学生考前备考使用。",
    { italics: true, align: AlignmentType.CENTER, color: "666666", size: 20, after: 240 },
  ));

  // ── Section 1: 10-year table ──
  children.push(p("一、10 年题目一览", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(makeTable(
    ["年份", "第一题（命题）", "第二题（看图）场景"],
    rows.map(r => {
      const i = interpByYear.get(r.year);
      const o2 = r.compoOption2 as { helpingWords?: string[] } | null;
      const scene = i?.option2Scene ?? "—";
      return [r.year, r.compoOption1Topic ?? "—", scene];
    }),
    [8, 40, 52],
  ));

  // ── Section 2: overview ──
  children.push(p("二、主题倾向总览", { heading: HeadingLevel.HEADING_1, before: 360, after: 120 }));
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [t(themes.overview, { size: 22 })],
  }));

  // ── Section 3: theme frequency table ──
  children.push(p("三、常见主题（按出现频率）", { heading: HeadingLevel.HEADING_1, before: 360, after: 120 }));
  children.push(makeTable(
    ["主题", "次数", "涉及年份"],
    themes.themes.map(th => [
      th.name,
      String(th.frequency),
      th.yearsAppeared.map(y => `${y.year}(O${y.option})`).join(", "),
    ]),
    [22, 8, 70],
  ));

  // ── Section 4: per-theme phrases ──
  children.push(p("四、各主题高分短语", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
  for (const th of themes.themes) {
    const ph = phraseByTheme.get(th.name);
    children.push(p(`${th.name} — ${th.description}`, {
      heading: HeadingLevel.HEADING_2, before: 280, after: 80,
    }));
    if (!ph || Object.values(ph.phrases).every(a => a.length === 0)) {
      children.push(p("（无范文可挖掘）", { italics: true, size: 20, color: "999999" }));
      continue;
    }
    if (ph.notes) {
      children.push(new Paragraph({
        spacing: { before: 60, after: 120 },
        children: [
          t("💡 备考建议：", { bold: true, size: 20, color: "996600" }),
          t(ph.notes, { italics: true, size: 20, color: "996600" }),
        ],
      }));
    }
    const sections: Array<[keyof PhrasesBucket, string]> = [
      ["opening", "✏️ 开头句式"],
      ["emotion", "💗 情感描写"],
      ["description", "🖼️ 动作 / 场景描写"],
      ["climax", "⚡ 高潮 / 转折"],
      ["conclusion", "🎯 结尾 / 道理（Moral）"],
    ];
    for (const [key, title] of sections) {
      const list = ph.phrases[key];
      if (list.length === 0) continue;
      children.push(p(title, { bold: true, size: 22, before: 160, after: 60 }));
      for (const phrase of list) {
        children.push(bullet(phrase, { size: 22 }));
      }
    }
  }

  // ── Methodology footer ──
  children.push(p("五、方法说明", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
  children.push(p("数据来源：MarkForYou Chinese Oral / Compo 后台已抽取的 10 年 PSLE 华文试卷一数据（含题目、看图作文图片、帮助词、官方范文）。", { size: 20, after: 80 }));
  children.push(p("Stage 1（图片解读）：每年第二题的图片送入 Gemini 3.1-pro，输出场景描述与故事走向推测。", { size: 20, after: 80 }));
  children.push(p("Stage 2（主题归纳）：将 10 年的题目 + 帮助词 + 图片解读合并送入 Gemini，识别反复出现的主题。", { size: 20, after: 80 }));
  children.push(p("Stage 3（短语挖掘）：每个主题对应的范文送入 Gemini，提取开头 / 情感 / 描写 / 高潮 / 结尾五大类高分短语。", { size: 20, after: 80 }));
  children.push(p("所有中间结果缓存在 scripts/compo-stage{1,2,3}-*.json，可单独重新生成任一阶段。", { size: 20, italics: true, color: "666666" }));

  const doc = new Document({
    creator: "MarkForYou",
    title: "PSLE Chinese Compo Analysis",
    sections: [{
      properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC} (${(buf.length / 1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
