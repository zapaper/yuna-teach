// Build PSLE-Chinese-Compo-Analysis.docx (v2) from the v2 caches.
// Run after analyze-compo-v2.ts has produced the JSON outputs.
//
// Layout:
//   §1 Theme heatmap by year (rows = morals, cols = 2016-2025)
//   §2 Overview + likely-next-year hint
//   §3 Per-moral breakdown
//   §4 Phrases — Opening (sub-types), Descriptors (emotions / scenery / action)
//   §5 Closings per moral (with English translation per phrase)
//   §6 Methodology

import { promises as fs } from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType,
} from "docx";

const SCRIPT_DIR = __dirname;
const V2_MORALS = path.join(SCRIPT_DIR, "compo-v2-morals.json");
const V2_PHRASES = path.join(SCRIPT_DIR, "compo-v2-phrases.json");
const V2_CLOSINGS = path.join(SCRIPT_DIR, "compo-v2-closings.json");
const V2_SENTENCES = path.join(SCRIPT_DIR, "compo-v2-sentences.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Analysis-v2.docx");

type Moral = {
  nameCn: string; nameEn: string; description: string;
  yearsAppeared: Array<{ year: string; option: 1 | 2; note: string }>;
  frequency: number;
};
type MoralsOutput = { overview: string; overviewEn?: string; morals: Moral[] };
type EmotionBucket = { emotionCn: string; emotionEn: string; phrases: string[] };
type SubGroup = { nameCn: string; nameEn: string; phrases: string[] };
type GroupedBank = { nameCn: string; nameEn: string; subgroups: SubGroup[] };
type PhrasesOutput = {
  openings: GroupedBank[];
  emotions: EmotionBucket[];
  sceneryWeather: GroupedBank;
  actions: GroupedBank;
};
type ClosingPhrase = { cn: string; en: string };
type ClosingsForMoral = { moralNameCn: string; closingPhrases: ClosingPhrase[] };
type ClosingsOutput = { perMoral: ClosingsForMoral[] };
type SentenceExample = {
  boringCn: string; boringEn: string;
  goodCn: string; goodEn: string;
  connectorCn: string; techniqueCn: string; techniqueEn: string;
};
type SentenceVariety = { examples: SentenceExample[] };

const CJK_FONT = "Microsoft YaHei";
const YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text,
    bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color,
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
// Split a sentence into runs so the connector substring renders
// bold + green while the rest stays plain. Used by §5 to highlight
// the joint phrase in each "better" example sentence.
function boldSubstringRun(text: string, substring: string): TextRun[] {
  if (!substring || !text.includes(substring)) {
    return [t(text, { size: 22 })];
  }
  const idx = text.indexOf(substring);
  const before = text.slice(0, idx);
  const after = text.slice(idx + substring.length);
  const runs: TextRun[] = [];
  if (before) runs.push(t(before, { size: 22 }));
  runs.push(t(substring, { size: 22, bold: true, color: "047857" }));
  if (after) runs.push(t(after, { size: 22 }));
  return runs;
}

function bullet(text: string, opts?: { size?: number; bold?: boolean }) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 30, after: 30 },
    children: [t(text, opts)],
  });
}
function cell(content: string | TextRun[], opts?: { bold?: boolean; size?: number; width?: number; align?: typeof AlignmentType[keyof typeof AlignmentType]; bg?: string; color?: string }) {
  const runs = typeof content === "string"
    ? [t(content, { bold: opts?.bold, size: opts?.size ?? 18, color: opts?.color })]
    : content;
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    shading: opts?.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: "auto" } : undefined,
    children: [new Paragraph({ alignment: opts?.align, children: runs })],
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

async function main() {
  const morals = JSON.parse(await fs.readFile(V2_MORALS, "utf8")) as MoralsOutput;
  const phrases = JSON.parse(await fs.readFile(V2_PHRASES, "utf8")) as PhrasesOutput;
  const closings = JSON.parse(await fs.readFile(V2_CLOSINGS, "utf8")) as ClosingsOutput;
  let sentences: SentenceVariety = { examples: [] };
  try { sentences = JSON.parse(await fs.readFile(V2_SENTENCES, "utf8")) as SentenceVariety; } catch { /* sentence cache may not exist yet */ }
  const closingByMoral = new Map(closings.perMoral.map(c => [c.moralNameCn, c.closingPhrases]));

  const children: (Paragraph | Table)[] = [];

  // ── Title ──
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 100 },
    children: [t("PSLE 华文作文 10 年主题与高分短语分析", { bold: true, size: 38 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [t("PSLE Chinese Composition Analysis (2016 – 2025)", { italics: true, size: 22, color: "666666" })],
  }));
  children.push(p(
    "10 年作文题目的具体道德 / 教训分布、跨年度主题热力图、与从 20 篇范文挖掘的高分短语库。专为 P6 学生考前备考与作文模板套用。",
    { italics: true, align: AlignmentType.CENTER, color: "666666", size: 20, after: 240 },
  ));

  // ── §1 Heatmap ──
  children.push(p("一、主题热力图 (Theme Heatmap by Year)", { heading: HeadingLevel.HEADING_1, before: 360, after: 120 }));
  children.push(p(
    "✓ 表示该年某一题涉及此道德主题；O1 = 第一题命题作文，O2 = 第二题看图作文。最右两列：英文名 + 10 年总次数。",
    { size: 18, italics: true, color: "666666", after: 120 },
  ));

  // Header row: 主题 | 2016 ... 2025 | English | Count
  const heatmapHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("中文主题", { bold: true, bg: "EEEEEE", width: 16 }),
      ...YEARS.map(y => cell(y, { bold: true, bg: "EEEEEE", align: AlignmentType.CENTER, width: 5 })),
      cell("English", { bold: true, bg: "EEEEEE", width: 22 }),
      cell("#", { bold: true, bg: "EEEEEE", align: AlignmentType.CENTER, width: 5 }),
    ],
  });

  const heatmapRows = morals.morals.map(m => {
    const hitsByYear = new Map<string, Array<1 | 2>>();
    for (const ya of m.yearsAppeared) {
      const arr = hitsByYear.get(ya.year) ?? [];
      arr.push(ya.option);
      hitsByYear.set(ya.year, arr);
    }
    return new TableRow({
      children: [
        cell(m.nameCn, { bold: true, size: 20 }),
        ...YEARS.map(y => {
          const opts = hitsByYear.get(y);
          if (!opts || opts.length === 0) {
            return cell("", { align: AlignmentType.CENTER });
          }
          const label = opts.sort().map(o => `O${o}`).join("/");
          return cell(label, { align: AlignmentType.CENTER, bg: "D1FAE5", color: "047857", bold: true, size: 18 });
        }),
        cell(m.nameEn, { italics: true, size: 18, color: "555555" }),
        cell(String(m.frequency), { bold: true, align: AlignmentType.CENTER, color: "047857" }),
      ],
    });
  });

  // Bottom row: # of morals per year
  const perYearCount = YEARS.map(y => {
    return morals.morals.reduce((s, m) => s + (m.yearsAppeared.some(ya => ya.year === y) ? 1 : 0), 0);
  });
  const totalRow = new TableRow({
    children: [
      cell("年度主题数", { bold: true, bg: "FAFAFA" }),
      ...perYearCount.map(c => cell(String(c), { bold: true, bg: "FAFAFA", align: AlignmentType.CENTER, color: c >= 3 ? "047857" : "555555" })),
      cell("", { bg: "FAFAFA" }),
      cell("", { bg: "FAFAFA" }),
    ],
  });

  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [heatmapHeader, ...heatmapRows, totalRow],
  }));

  // ── §2 Overview (bilingual) ──
  children.push(p("二、整体观察与今年预测 (Overview & Prediction)", { heading: HeadingLevel.HEADING_1, before: 360, after: 120 }));
  children.push(p("中文 (Chinese)", { bold: true, size: 22, color: "B91C1C", before: 80, after: 60 }));
  children.push(new Paragraph({
    spacing: { after: 160 },
    children: [t(morals.overview, { size: 22 })],
  }));
  if (morals.overviewEn) {
    children.push(p("English", { bold: true, size: 22, color: "B91C1C", before: 80, after: 60 }));
    children.push(new Paragraph({
      spacing: { after: 200 },
      children: [t(morals.overviewEn, { size: 22, italics: true, color: "333333" })],
    }));
  }

  // ── §3 Per-moral breakdown ──
  children.push(p("三、各具体道德主题说明 (Specific Morals — What Each Means)", { heading: HeadingLevel.HEADING_1, before: 360, after: 120 }));
  for (const m of morals.morals) {
    children.push(new Paragraph({
      spacing: { before: 160, after: 40 },
      children: [
        t(`${m.nameCn} — `, { bold: true, size: 24 }),
        t(m.nameEn, { italics: true, size: 22, color: "555555" }),
        t(`  (${m.frequency}×)`, { size: 20, color: "047857", bold: true }),
      ],
    }));
    children.push(p(m.description, { size: 20, after: 60, color: "555555" }));
    if (m.yearsAppeared.length) {
      const lines = m.yearsAppeared.map(ya => `${ya.year} (O${ya.option}): ${ya.note}`);
      for (const line of lines) children.push(bullet(line, { size: 18 }));
    }
  }

  // ── §4 Phrases (sub-grouped, all with English headers) ──
  children.push(p("四、高分短语库 (Phrase Bank — Pooled from All 20 Model Essays)", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
  children.push(p("每个类别的短语都是从 10 年 20 篇官方范文中跨篇汇总。每个 sub-group 都附英文翻译表头。", { italics: true, color: "666666", size: 20, after: 200 }));

  // Helper: render a SubGroup (sub-header + bullet phrases)
  function renderSubGroup(sg: SubGroup) {
    children.push(new Paragraph({
      spacing: { before: 140, after: 50 },
      children: [
        t(`${sg.nameCn} — `, { bold: true, size: 22, color: "B91C1C" }),
        t(sg.nameEn, { italics: true, size: 20, color: "555555" }),
      ],
    }));
    for (const ph of sg.phrases) children.push(bullet(ph, { size: 22 }));
  }

  // 4A — Openings (weather + reflection only; drop action/dialogue)
  children.push(p("4A. 开头 (Opening Phrases)", { heading: HeadingLevel.HEADING_2, before: 240, after: 120 }));
  for (const op of phrases.openings) {
    children.push(new Paragraph({
      spacing: { before: 200, after: 80 },
      children: [
        t(`${op.nameCn} — `, { bold: true, size: 24 }),
        t(op.nameEn, { italics: true, size: 22, color: "555555" }),
      ],
    }));
    for (const sg of op.subgroups) renderSubGroup(sg);
  }

  // 4B — Descriptors
  children.push(p("4B. 描写 (Descriptor Phrases)", { heading: HeadingLevel.HEADING_2, before: 320, after: 120 }));

  // (i) Emotions
  children.push(p("(i) 情感 (Emotions) — Grouped by feeling", { bold: true, size: 22, before: 160, after: 80 }));
  for (const em of phrases.emotions) {
    children.push(new Paragraph({
      spacing: { before: 140, after: 50 },
      children: [
        t(`${em.emotionCn} — `, { bold: true, size: 22, color: "B91C1C" }),
        t(em.emotionEn, { italics: true, size: 20, color: "555555" }),
      ],
    }));
    for (const ph of em.phrases) children.push(bullet(ph, { size: 22 }));
  }

  // (ii) Scenery/Weather — sub-grouped
  if (phrases.sceneryWeather?.subgroups?.length) {
    children.push(p(`(ii) ${phrases.sceneryWeather.nameCn} (${phrases.sceneryWeather.nameEn}) — Grouped by weather type`, {
      bold: true, size: 22, before: 240, after: 80,
    }));
    for (const sg of phrases.sceneryWeather.subgroups) renderSubGroup(sg);
  }

  // (iii) Actions — sub-grouped
  if (phrases.actions?.subgroups?.length) {
    children.push(p(`(iii) ${phrases.actions.nameCn} (${phrases.actions.nameEn}) — Grouped by action type`, {
      bold: true, size: 22, before: 240, after: 80,
    }));
    for (const sg of phrases.actions.subgroups) renderSubGroup(sg);
  }

  // ── §5 Sentence variety (boring vs interesting openings) ──
  if (sentences.examples?.length) {
    children.push(p("五、句子起步技巧 (Sentence Variety — Avoid Noun + Verb Monotony)", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
    children.push(p("学生最常犯的毛病是「妈妈走进厨房。她开始做饭。」每句都是「名词 + 动词」开头。下面 5-6 个例子展示如何用关联词 / 衔接短语让句首更有变化。**粗体**部分是关键的关联词。", {
      italics: true, color: "666666", size: 20, after: 200,
    }));
    sentences.examples.forEach((ex, idx) => {
      children.push(new Paragraph({
        spacing: { before: 260, after: 60 },
        children: [
          t(`例 ${idx + 1}：`, { bold: true, size: 24, color: "1E40AF" }),
          t(ex.techniqueCn, { bold: true, size: 22 }),
          t(`  (${ex.techniqueEn})`, { italics: true, size: 18, color: "555555" }),
        ],
      }));
      // Boring version
      children.push(new Paragraph({
        spacing: { before: 80, after: 30 },
        children: [t("乏味写法 (Boring):", { bold: true, size: 20, color: "888888" })],
      }));
      children.push(new Paragraph({
        spacing: { after: 20 },
        children: [t(`  ${ex.boringCn}`, { size: 22, color: "888888" })],
      }));
      children.push(new Paragraph({
        spacing: { after: 80 },
        children: [t(`  ${ex.boringEn}`, { italics: true, size: 18, color: "999999" })],
      }));
      // Good version — bold the connector substring
      children.push(new Paragraph({
        spacing: { before: 80, after: 30 },
        children: [t("有变化的写法 (Better):", { bold: true, size: 20, color: "047857" })],
      }));
      children.push(new Paragraph({
        spacing: { after: 20 },
        children: boldSubstringRun(`  ${ex.goodCn}`, ex.connectorCn),
      }));
      children.push(new Paragraph({
        spacing: { after: 60 },
        children: [t(`  ${ex.goodEn}`, { italics: true, size: 18, color: "555555" })],
      }));
    });
  }

  // ── §6 Closings per moral with English translations ──
  children.push(p("六、各主题结尾点题句 (Closing Phrases by Moral — with English)", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
  children.push(p("作文结尾点题最能拉分。下表按主题分组，每个短语附中英对照，方便和家长 / 老师讨论。", { italics: true, color: "666666", size: 20, after: 160 }));

  for (const m of morals.morals) {
    const cps = closingByMoral.get(m.nameCn) ?? [];
    if (cps.length === 0) continue;
    children.push(new Paragraph({
      spacing: { before: 280, after: 80 },
      children: [
        t(`${m.nameCn} — `, { bold: true, size: 24 }),
        t(`${m.nameEn} closing phrases`, { italics: true, size: 22, color: "555555" }),
      ],
    }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorder(),
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            cell("中文短语", { bold: true, bg: "EEEEEE", width: 50 }),
            cell("English translation", { bold: true, bg: "EEEEEE", width: 50 }),
          ],
        }),
        ...cps.map(cp => new TableRow({
          children: [
            cell(cp.cn, { size: 22 }),
            cell(cp.en, { size: 20, color: "555555", italics: true }),
          ],
        })),
      ],
    }));
  }

  // ── §7 Methodology ──
  children.push(p("七、方法说明 (Methodology)", { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));
  children.push(p("数据来源：MarkForYou Chinese Oral / Compo 后台抽取的 10 年 PSLE 华文试卷一数据（题目、看图作文图片、帮助词、官方范文）。", { size: 20, after: 80 }));
  children.push(p("Stage 1 (picture interpretation)：每年第二题图片送入 Gemini 3.1-pro 解读场景。", { size: 20, after: 80 }));
  children.push(p("Stage A (morals classification)：跨年度题目 + 范文片段送入 Gemini 识别具体道德主题，按出现频率排序。", { size: 20, after: 80 }));
  children.push(p("Stage B (phrase aggregation)：20 篇范文一次性送入 Gemini，按用途（开头 / 情感 / 景物 / 动作）汇总短语。", { size: 20, after: 80 }));
  children.push(p("Stage C (closing mining)：每个具体道德对应的范文送入 Gemini，提取适合作文结尾点题的短语，附英文翻译。", { size: 20, after: 80 }));
  children.push(p("所有中间结果缓存为 JSON，可单独重新生成任一阶段。", { size: 20, italics: true, color: "666666" }));

  const doc = new Document({
    creator: "MarkForYou",
    title: "PSLE Chinese Compo Analysis v2",
    sections: [{
      properties: { page: { margin: { top: 800, right: 800, bottom: 800, left: 800 } } },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC} (${(buf.length / 1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
