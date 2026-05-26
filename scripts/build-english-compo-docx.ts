// Build PSLE-English-Compo-Analysis.docx from the eng-compo caches.
// Run after analyze-english-compo.ts has produced the JSON outputs.
//
// Layout (after Peter's feedback):
//   §1 Theme heatmaps — situational (predictive) + continuous (NOT predictive)
//   §2 Overview + hand-picked situational prediction
//   §3 Situational Writing
//        3a  Per-theme year evidence
//        3b  Typical paragraph structure
//        3c  Key info checklist
//        3d  The 'reason' paragraph craft (moves + phrase bank)
//   §4 Continuous Writing
//        4a  Structural patterns observed across model essays
//        4b  Craft tips by category (sentence variety, flow, pacing, emotion …)
//        4c  Opening + closing phrase bank
//        4d  Show, don't tell — by emotion
//        4e  Sensory descriptions
//        4f  Dialogue tags
//   §5 Sentence variety upgrades (applies to both)

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
const SITUATIONAL_CACHE = path.join(SCRIPT_DIR, "eng-compo-situational.json");
const CONTINUOUS_CRAFT_CACHE = path.join(SCRIPT_DIR, "eng-compo-continuous-craft.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-English-Compo-Analysis.docx");

const YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

// Hand-picked override per Peter — auto-prediction was OK but he wanted
// the doc to lead with the situational call. Continuous theme is too
// varied year-on-year to predict ("just leave the heatmap there and
// say it's no use to spot").
const SITUATIONAL_PREDICTION_OVERRIDE =
  "Most likely situational theme this year: PERSUASION / ENCOURAGEMENT. " +
  "It's the dominant communicative move in this dataset (2017, 2020, 2022, 2023) and " +
  "did NOT come up in 2024 or 2025 — overdue for a return. Train the persuasive 'reason' " +
  "paragraph craft below, since that's where situational marks are won or lost.";
const CONTINUOUS_THEME_CAVEAT =
  "The continuous-writing theme changes every year (gift, secret, teamwork, a long wait, trying " +
  "something new, being thankful …). There's NO repeating pattern to predict — and trying to " +
  "memorise theme-specific phrases is wasted effort. Focus instead on §4 craft: structural " +
  "patterns, sentence variety, and show-don't-tell — those transfer across any theme.";

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

type SituationalParagraph = { paragraphLabel: string; whatItDoes: string; sampleOpeners: string[] };
type ReasonMove = { move: string; why: string; examples: string[] };
type SituationalCraft = {
  typicalStructure: SituationalParagraph[];
  keyInfoChecklist: string[];
  reasonParagraphOverview: string;
  reasonParagraphMoves: ReasonMove[];
  reasonParagraphPhrases: PhraseGroup[];
};

type StructuralPattern = {
  pattern: string; frequency: string; description: string;
  examples: Array<{ year: string; quote: string }>;
};
type CraftRow = { category: string; weak: string; strong: string; highlight: string };
type ContinuousCraft = { structuralPatterns: StructuralPattern[]; craftRows: CraftRow[] };

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
function bullet(text: string, opts?: { size?: number; bold?: boolean; italics?: boolean; color?: string }) {
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
function calloutPara(text: string, fill = "FEF3C7", color = "92400E"): Paragraph {
  return new Paragraph({
    spacing: { before: 80, after: 120 },
    shading: { type: ShadingType.CLEAR, fill, color: "auto" },
    children: [t(text, { size: 22, bold: true, color })],
  });
}

function heatmapTable(themes: Array<{ name: string; yearsAppeared: Array<{ year: string }>; frequency: number }>, headerBg = "DBEAFE"): Table {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell("Theme", { bold: true, width: 28, bg: headerBg, size: 18 }),
      cell("#", { bold: true, width: 6, bg: headerBg, align: AlignmentType.CENTER, size: 18 }),
      ...YEARS.map(y => cell(y.slice(2), { bold: true, width: 6, bg: headerBg, align: AlignmentType.CENTER, size: 18 })),
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
  const sitCraft = JSON.parse(await fs.readFile(SITUATIONAL_CACHE, "utf8")) as SituationalCraft;
  const contCraft = JSON.parse(await fs.readFile(CONTINUOUS_CRAFT_CACHE, "utf8")) as ContinuousCraft;

  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(p("PSLE English Composition — 10-Year Analysis (2016-2025)", { heading: HeadingLevel.TITLE, align: AlignmentType.CENTER, after: 200 }));
  children.push(p("Paper 1 Writing • Situational + Continuous • generated from extracted past-year papers", { italics: true, color: "6B7280", align: AlignmentType.CENTER, after: 300, size: 20 }));

  // §1 Heatmaps
  children.push(p("§1  Theme Heatmaps", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));

  children.push(p("Situational Writing — by communicative purpose", { heading: HeadingLevel.HEADING_2, before: 160, after: 80 }));
  children.push(heatmapTable(themes.situationalThemes, "DBEAFE"));

  children.push(p("Continuous Writing — by narrative theme", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(calloutPara(`⚠️  ${CONTINUOUS_THEME_CAVEAT}`, "FEE2E2", "991B1B"));
  children.push(heatmapTable(themes.continuousThemes, "FEE2E2"));

  // §2 Overview + prediction (situational only)
  children.push(p("§2  Overview & Likely Situational Topic", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p(themes.overview, { size: 22, after: 120 }));
  children.push(p("Prediction for the next PSLE situational", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(calloutPara(SITUATIONAL_PREDICTION_OVERRIDE, "FEF3C7", "92400E"));

  // §3 Situational Writing
  children.push(p("§3  Situational Writing", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));

  // 3a — per-theme year evidence
  children.push(p("3a · Year-by-year evidence per theme", { heading: HeadingLevel.HEADING_2, before: 160, after: 40 }));
  for (const th of themes.situationalThemes) {
    children.push(p(`${th.name}  (×${th.frequency})`, { bold: true, size: 22, before: 100, after: 30 }));
    children.push(p(th.description, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ya of th.yearsAppeared) {
      children.push(bullet(`${ya.year}: ${ya.note}`, { size: 20 }));
    }
  }

  // 3b — typical paragraph structure
  children.push(p("3b · Typical paragraph structure", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p("Almost every model essay follows this 4-block pattern. Use it as scaffolding when planning the answer.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  for (const para of sitCraft.typicalStructure) {
    children.push(p(para.paragraphLabel, { bold: true, color: "1E40AF", size: 22, before: 120, after: 20 }));
    children.push(p(para.whatItDoes, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const op of para.sampleOpeners) {
      children.push(bullet(op, { size: 22 }));
    }
  }

  // 3c — key info checklist
  children.push(p("3c · Key info checklist — what MUST be inside", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p("Marker deductions come from missing required facts more than from poor phrasing. Tick these off before writing.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  for (const item of sitCraft.keyInfoChecklist) {
    children.push(bullet(`☐  ${item}`, { size: 22 }));
  }

  // 3d — the reason paragraph
  children.push(p('3d · The "Reason" paragraph — where situational marks are won', { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p(sitCraft.reasonParagraphOverview, { size: 22, after: 120 }));
  children.push(p("Rhetorical moves used by model essays", { bold: true, size: 22, color: "1E40AF", before: 100, after: 40 }));
  for (const m of sitCraft.reasonParagraphMoves) {
    children.push(p(m.move, { bold: true, size: 22, color: "047857", before: 100, after: 20 }));
    children.push(p(`Why it works:  ${m.why}`, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ex of m.examples) {
      children.push(bullet(ex, { size: 20, italics: true, color: "374151" }));
    }
  }
  children.push(p("Sample phrases for the reason paragraph", { bold: true, size: 22, color: "1E40AF", before: 200, after: 40 }));
  for (const g of sitCraft.reasonParagraphPhrases) children.push(...phraseGroupBlock(g));

  // §4 Continuous Writing
  children.push(p("§4  Continuous Writing", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("The theme is unpredictable — what's CONSISTENT is the craft of writing a high-scoring narrative. Drill these.", { italics: true, color: "6B7280", size: 20, after: 80 }));

  // 4a — structural patterns
  children.push(p("4a · Structural patterns observed across model essays", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const sp of contCraft.structuralPatterns) {
    children.push(new Paragraph({
      spacing: { before: 120, after: 20 },
      children: [
        t(sp.pattern, { bold: true, size: 22, color: "1E40AF" }),
        t(`  (${sp.frequency})`, { color: "6B7280", size: 20 }),
      ],
    }));
    children.push(p(sp.description, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ex of sp.examples) {
      children.push(bullet(`${ex.year}:  "${ex.quote}"`, { size: 20, color: "374151" }));
    }
  }

  // 4b — craft tips: weak → strong table (same red/green style as §5)
  children.push(p("4b · Craft upgrades — weak ➜ stronger", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p("One concrete upgrade per craft category. Each row shows the typical P5-level phrasing and the upgraded version with the key swap highlighted.", { italics: true, color: "6B7280", size: 20, after: 120 }));
  const craftHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Category", { bold: true, width: 18, bg: "EDE9FE" }),
      cell("Weak", { bold: true, width: 32, bg: "FEE2E2" }),
      cell("Stronger", { bold: true, width: 50, bg: "D1FAE5" }),
    ],
  });
  const craftRows = contCraft.craftRows.map(row => new TableRow({
    children: [
      cell(row.category, { size: 20, color: "5B21B6", bold: true }),
      cell(row.weak, { size: 22 }),
      new TableCell({
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [new Paragraph({ children: boldSubstringRun(row.strong, row.highlight) })],
      }),
    ],
  }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [craftHeader, ...craftRows],
  }));

  // 4c — openings + closings phrase bank
  children.push(p("4c · Opening + closing phrase bank", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p("Hook the reader at paragraph 1 and land the takeaway at the final paragraph.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  children.push(p("Openings (hook)", { bold: true, size: 22, color: "1E40AF", before: 120, after: 40 }));
  for (const g of phrases.continuousOpenings) children.push(...phraseGroupBlock(g));
  children.push(p("Closings (land the story)", { bold: true, size: 22, color: "1E40AF", before: 200, after: 40 }));
  for (const g of phrases.continuousClosings) children.push(...phraseGroupBlock(g));

  // 4d — show, don't tell
  children.push(p("4d · Show, don't tell — body & sensation by emotion", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p("'I was scared' is told; 'My palms turned clammy and my knees gave way beneath me' is shown. Match the emotion, pull a line.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  for (const g of phrases.showDontTell) children.push(...phraseGroupBlock({ name: g.name, phrases: g.phrases }));

  // 4e — sensory descriptions
  children.push(p("4e · Sensory descriptions (the 5 senses)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of phrases.sensoryDescriptions) children.push(...phraseGroupBlock(g));

  // 4f — dialogue tags
  children.push(p('4f · Dialogue tags — alternatives to "said"', { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(p(phrases.dialogueTags.join(" • "), { size: 22, after: 80 }));

  // §5 Sentence variety
  children.push(p("§5  Sentence Variety — Weak ➜ Strong Upgrades", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Generic sentence on the left; upgraded rewrite on the right with the swap highlighted. Applies to both writing sections.", { italics: true, color: "6B7280", size: 20, after: 120 }));
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
