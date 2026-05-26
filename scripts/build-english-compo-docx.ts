// Build PSLE-English-Compo-Analysis.docx from the eng-compo caches.
// Run after analyze-english-compo.ts has produced the JSON outputs.
//
// Layout:
//   §1 Theme heatmaps — situational + continuous (rows = themes, cols = years)
//   §2 Overview + next-year prediction
//   §3 Per-theme breakdown (situational, then continuous)
//   §4 Situational phrase bank — openings, connectors, closings
//   §5 Continuous phrase bank — openings, show-don't-tell, sensory, dialogue tags, closings
//   §6 Sentence variety upgrades (weak → strong)

import { promises as fs } from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType,
} from "docx";

const SCRIPT_DIR = __dirname;
const THEMES_CACHE = path.join(SCRIPT_DIR, "eng-compo-themes.json");
const PHRASES_CACHE = path.join(SCRIPT_DIR, "eng-compo-phrases.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-English-Compo-Analysis.docx");

const YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

type SituationalTheme = {
  name: string; description: string;
  yearsAppeared: Array<{ year: string; note: string }>;
  frequency: number;
};
type ContinuousTheme = {
  name: string; description: string;
  yearsAppeared: Array<{ year: string; pickedTheme: string; note: string }>;
  frequency: number;
};
type ThemesOutput = {
  overview: string; prediction: string;
  situationalThemes: SituationalTheme[];
  continuousThemes: ContinuousTheme[];
};

type PhraseGroup = { name: string; phrases: string[] };
type SentenceExample = { weak: string; strong: string; technique: string; highlight: string };
type PhrasesOutput = {
  situationalOpenings: PhraseGroup[];
  situationalConnectors: PhraseGroup[];
  situationalClosings: PhraseGroup[];
  continuousOpenings: PhraseGroup[];
  showDontTell: { name: string; phrases: string[] }[];
  sensoryDescriptions: PhraseGroup[];
  dialogueTags: string[];
  continuousClosings: PhraseGroup[];
  sentenceVariety: SentenceExample[];
};

function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text, bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color,
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
function bullet(text: string, opts?: { size?: number; bold?: boolean }) {
  return new Paragraph({
    bullet: { level: 0 }, spacing: { before: 30, after: 30 },
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
function boldSubstringRun(text: string, substring: string): TextRun[] {
  if (!substring || !text.includes(substring)) return [t(text, { size: 22 })];
  const idx = text.indexOf(substring);
  const before = text.slice(0, idx);
  const after = text.slice(idx + substring.length);
  const runs: TextRun[] = [];
  if (before) runs.push(t(before, { size: 22 }));
  runs.push(t(substring, { size: 22, bold: true, color: "047857" }));
  if (after) runs.push(t(after, { size: 22 }));
  return runs;
}

// Heatmap: rows = themes, cols = years, cell shaded green if year appeared.
function heatmapTable(
  title: string,
  themes: Array<{ name: string; yearsAppeared: Array<{ year: string }>; frequency: number }>,
): Table {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell("Theme", { bold: true, width: 28, bg: "DBEAFE", size: 18 }),
      cell("#", { bold: true, width: 6, bg: "DBEAFE", align: AlignmentType.CENTER, size: 18 }),
      ...YEARS.map(y => cell(y.slice(2), { bold: true, width: 6, bg: "DBEAFE", align: AlignmentType.CENTER, size: 18 })),
    ],
  });
  const rows = themes.map(theme => {
    const yearSet = new Set(theme.yearsAppeared.map(y => y.year));
    return new TableRow({
      children: [
        cell(theme.name, { size: 18 }),
        cell(String(theme.frequency), { bold: true, align: AlignmentType.CENTER, size: 18 }),
        ...YEARS.map(y => yearSet.has(y)
          ? cell("✓", { align: AlignmentType.CENTER, bold: true, color: "047857", bg: "D1FAE5", size: 18 })
          : cell("", { align: AlignmentType.CENTER, bg: "F9FAFB", size: 18 })),
      ],
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [header, ...rows],
  });
}

function phraseGroupBlock(group: PhraseGroup): Paragraph[] {
  return [
    p(group.name, { bold: true, before: 120, after: 40, size: 22 }),
    ...group.phrases.map(ph => bullet(ph, { size: 22 })),
  ];
}

async function main() {
  const themes = JSON.parse(await fs.readFile(THEMES_CACHE, "utf8")) as ThemesOutput;
  const phrases = JSON.parse(await fs.readFile(PHRASES_CACHE, "utf8")) as PhrasesOutput;

  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(p("PSLE English Composition — 10-Year Analysis (2016-2025)", { heading: HeadingLevel.TITLE, align: AlignmentType.CENTER, after: 200 }));
  children.push(p("Paper 1 Writing • Situational + Continuous • generated from extracted past-year papers", { italics: true, color: "6B7280", align: AlignmentType.CENTER, after: 300, size: 20 }));

  // §1 Heatmaps
  children.push(p("§1  Theme Heatmaps", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Situational Writing — by communicative purpose", { heading: HeadingLevel.HEADING_2, before: 160, after: 80 }));
  children.push(heatmapTable("situational", themes.situationalThemes));
  children.push(p("Continuous Writing — by narrative theme", { heading: HeadingLevel.HEADING_2, before: 200, after: 80 }));
  children.push(heatmapTable("continuous", themes.continuousThemes));

  // §2 Overview + prediction
  children.push(p("§2  Overview & Likely Next Year", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Overview", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(p(themes.overview, { size: 22, after: 120 }));
  children.push(p("Most likely topic for next PSLE", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(new Paragraph({
    spacing: { after: 120 },
    shading: { type: ShadingType.CLEAR, fill: "FEF3C7", color: "auto" },
    children: [t(themes.prediction, { size: 22, bold: true, color: "92400E" })],
  }));

  // §3 Per-theme breakdown
  children.push(p("§3  Per-Theme Detail", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Situational themes", { heading: HeadingLevel.HEADING_2, before: 120, after: 60 }));
  for (const th of themes.situationalThemes) {
    children.push(p(`${th.name}  (×${th.frequency})`, { bold: true, size: 22, before: 100, after: 30 }));
    children.push(p(th.description, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ya of th.yearsAppeared) {
      children.push(bullet(`${ya.year}: ${ya.note}`, { size: 20 }));
    }
  }
  children.push(p("Continuous themes", { heading: HeadingLevel.HEADING_2, before: 200, after: 60 }));
  for (const th of themes.continuousThemes) {
    children.push(p(`${th.name}  (×${th.frequency})`, { bold: true, size: 22, before: 100, after: 30 }));
    children.push(p(th.description, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ya of th.yearsAppeared) {
      children.push(bullet(`${ya.year} — "${ya.pickedTheme}" — ${ya.note}`, { size: 20 }));
    }
  }

  // §4 Situational phrase bank
  children.push(p("§4  Situational Writing — Phrase Bank", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Use these to lift the formal-ish tone of a letter / email / announcement.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  children.push(p("Openings", { heading: HeadingLevel.HEADING_2, before: 160, after: 40 }));
  for (const g of phrases.situationalOpenings) children.push(...phraseGroupBlock(g));
  children.push(p("Connectors / structure", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.situationalConnectors) children.push(...phraseGroupBlock(g));
  children.push(p("Closings", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.situationalClosings) children.push(...phraseGroupBlock(g));

  // §5 Continuous phrase bank
  children.push(p("§5  Continuous Writing — Phrase Bank", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Show-don't-tell, sensory imagery, dialogue tags and openings to lift narrative writing.", { italics: true, color: "6B7280", size: 20, after: 80 }));

  children.push(p("Openings (hook the reader)", { heading: HeadingLevel.HEADING_2, before: 160, after: 40 }));
  for (const g of phrases.continuousOpenings) children.push(...phraseGroupBlock(g));

  children.push(p("Show, don't tell — body & sensation by emotion", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.showDontTell) children.push(...phraseGroupBlock({ name: g.name, phrases: g.phrases }));

  children.push(p("Sensory descriptions (the 5 senses)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.sensoryDescriptions) children.push(...phraseGroupBlock(g));

  children.push(p("Dialogue tags — alternatives to \"said\"", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p(phrases.dialogueTags.join(" • "), { size: 22, after: 80 }));

  children.push(p("Closings (land the story)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.continuousClosings) children.push(...phraseGroupBlock(g));

  // §6 Sentence variety
  children.push(p("§6  Sentence Variety — Weak ➜ Strong Upgrades", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Each row shows a generic sentence followed by an upgraded one, with the technique named. The highlighted phrase is the key swap.", { italics: true, color: "6B7280", size: 20, after: 120 }));
  const svHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Weak", { bold: true, width: 35, bg: "FEE2E2" }),
      cell("Stronger", { bold: true, width: 50, bg: "D1FAE5" }),
      cell("Technique", { bold: true, width: 15, bg: "DBEAFE" }),
    ],
  });
  const svRows = phrases.sentenceVariety.map(ex => new TableRow({
    children: [
      cell(ex.weak, { size: 22 }),
      new TableCell({
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [new Paragraph({ children: boldSubstringRun(ex.strong, ex.highlight) })],
      }),
      cell(ex.technique, { size: 20, color: "1E40AF" }),
    ],
  }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [svHeader, ...svRows],
  }));

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC}`);
}
main().catch(e => { console.error(e); process.exit(1); });
