// Regenerate the Tier 1 / Tier 2 Word docs with a more compact
// 5-column layout:
//
//   词 | 拼音 | 中文意思 (English below) | 例句 1 (例句 2 below) | 来源
//
// Same data, just denser table. No Gemini calls needed.

import * as fs from "fs";
import * as path from "path";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, ShadingType,
} from "docx";

type Entry = {
  word: string;
  chars: number;
  category: string;
  source: "PSLE" | "P5" | "P6" | "P5+P6" | string;
  psleHistory?: string[];
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
  tier?: 1 | 2;
};

(async () => {
  const jsonPath = path.join(__dirname, "psle-chinese-study-bank.json");
  const bank = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Entry[];

  const tier1 = bank.filter(e => e.tier === 1);
  const tier2 = bank.filter(e => e.tier === 2);

  // Column widths in 1/1000ths of a percent — column 1 (word + pinyin)
  // gets a wider share since it carries the two-line stacked content
  // (Chinese chars + pinyin) that's visually dense.
  const COL_WIDTHS = [28, 28, 36, 8];  // percentages summing to 100; col 1 widened from 25 → 28; col 3 trims since we now show only 1 sample sentence

  function headerCell(text: string, widthPct: number): TableCell {
    return new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.SOLID, color: "DDDDDD" },
      children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
    });
  }

  function headerRow(): TableRow {
    return new TableRow({
      tableHeader: true,
      children: [
        headerCell("词 / 拼音", COL_WIDTHS[0]),
        headerCell("意思 / Meaning", COL_WIDTHS[1]),
        headerCell("例句", COL_WIDTHS[2]),
        headerCell("来源", COL_WIDTHS[3]),
      ],
    });
  }

  // Cell with multiple stacked paragraphs (zh + en)
  function stackedCell(
    lines: Array<{ text: string; italics?: boolean; color?: string; size?: number }>,
    widthPct: number
  ): TableCell {
    return new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      children: lines.map(line =>
        new Paragraph({
          children: [new TextRun({
            text: line.text,
            italics: line.italics ?? false,
            color: line.color,
            size: line.size ?? 20,
          })],
          spacing: { after: 40 },
        })
      ),
    });
  }

  function entryRow(e: Entry): TableRow {
    const wordCell = new TableCell({
      width: { size: COL_WIDTHS[0], type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({ children: [new TextRun({ text: e.word, bold: true, size: 28 })], spacing: { after: 40 } }),
        new Paragraph({ children: [new TextRun({ text: e.pinyin ?? "—", size: 18, color: "555555" })] }),
      ],
    });
    const meaningCell = stackedCell([
      { text: e.meaningZh ?? "—", size: 20 },
      { text: e.meaningEn ?? "—", italics: true, color: "555555", size: 18 },
    ], COL_WIDTHS[1]);
    const sampleCell = new TableCell({
      width: { size: COL_WIDTHS[2], type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({ children: [new TextRun({ text: e.sample1 ?? "—", size: 20 })] }),
      ],
    });
    const sourceCell = new TableCell({
      width: { size: COL_WIDTHS[3], type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text: e.source === "PSLE" ? "🏆" : `📘 ${e.source}`, size: 18 })] })],
    });
    return new TableRow({
      children: [wordCell, meaningCell, sampleCell, sourceCell],
    });
  }

  function buildSectionTable(entries: Entry[]): Table {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow(), ...entries.map(entryRow)],
    });
  }

  function buildDoc(title: string, intro: string, sections: Array<{ title: string; note: string; entries: Entry[] }>): Document {
    const children: (Paragraph | Table)[] = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }));
    children.push(new Paragraph(intro));
    for (const s of sections) {
      if (s.entries.length === 0) continue;
      children.push(new Paragraph({ children: [new TextRun("")] }));
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${s.title} (${s.entries.length} 个)`)] }));
      children.push(new Paragraph({ children: [new TextRun({ text: s.note, italics: true, size: 18 })] }));
      children.push(buildSectionTable(s.entries));
    }
    return new Document({ sections: [{ children }] });
  }

  const t1Sections = [
    { title: "一、二字词语 (Q5-Q6 / Q13-Q15 风格)", note: "考的是抽象动词、形容词、情感动作词。这一类最容易丢分。", entries: tier1.filter(e => e.category === "2字词语") },
    { title: "二、四字成语 (Q7-Q8 风格)", note: "考的是成语的真正意思 (不是字面意思)。背的时候要连\"用在什么场景\"一起记。", entries: tier1.filter(e => e.category === "成语") },
    { title: "三、关联词 (Q9-Q10)", note: "数量少，但每年都考。务必全部背熟。", entries: tier1.filter(e => e.category === "关联词") },
    { title: "四、短文填空高频词 (Q16-Q20)", note: "短文填空的正确答案。这些词每年都换，但风格类似。", entries: tier1.filter(e => e.category === "短文填空") },
  ];
  const t1Doc = buildDoc(
    "PSLE 华文词汇学习卡 — Tier 1 (必背)",
    `把这本带回家，让孩子每天背 10-15 个，每周复习一次。
来源：🏆 PSLE 真题归纳 (6 年) + 📘 P5/P6 词语单中最匹配 PSLE 风格的核心词。
共 ${tier1.length} 个词。`,
    t1Sections
  );

  const t2Sections = [
    { title: "一、二字词语 (扩展)", note: "属于 P5/P6 词语单里有价值但不是 PSLE 主流风格的词。学有余力时再背。", entries: tier2.filter(e => e.category === "2字词语") },
    { title: "二、四字成语 (扩展)", note: "P5/P6 词语单里的其他成语。能多认识总没坏处。", entries: tier2.filter(e => e.category === "成语") },
    { title: "三、关联词 (扩展)", note: "其他可能出现的关联词。", entries: tier2.filter(e => e.category === "关联词") },
    { title: "四、短文填空高频词 (扩展)", note: "扩展词汇。", entries: tier2.filter(e => e.category === "短文填空") },
  ];
  const t2Doc = buildDoc(
    "PSLE 华文词汇学习卡 — Tier 2 (拓展)",
    `这本是学有余力时的拓展词库。先把 Tier 1 (必背) 背好，再来看这本。
共 ${tier2.length} 个词。`,
    t2Sections
  );

  const outDir = path.join(__dirname, "..", "..", "documents");
  const t1Path = path.join(outDir, "PSLE 华文词汇学习卡 (Tier 1 — 必背).docx");
  const t2Path = path.join(outDir, "PSLE 华文词汇学习卡 (Tier 2 — 拓展).docx");
  fs.writeFileSync(t1Path, await Packer.toBuffer(t1Doc));
  fs.writeFileSync(t2Path, await Packer.toBuffer(t2Doc));
  console.log(`Wrote ${t1Path} (${tier1.length} entries, compact 5-col layout)`);
  console.log(`Wrote ${t2Path} (${tier2.length} entries, compact 5-col layout)`);
})();
