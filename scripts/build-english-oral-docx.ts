// Build PSLE-English-Oral-Analysis.docx from the eng-oral caches.
// Run after analyze-english-oral.ts has produced the JSON outputs.
//
// Layout:
//   §1 SBC topic heatmap (rows = themes, cols = years; cells split D1/D2)
//   §2 Overview + likely next-year topic prediction
//   §3 Per-theme detail
//   §4 PEEL technique — by question type
//   §5 Sentence starters that aren't "I think..."
//      ↳ general openers, agreement, disagreement, personal anecdote,
//        hedges/qualifiers, closing moves
//   §6 Weak ➜ Strong upgrades

import { promises as fs } from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType,
} from "docx";

const SCRIPT_DIR = __dirname;
const THEMES_CACHE = path.join(SCRIPT_DIR, "eng-oral-themes.json");
const TECHNIQUES_CACHE = path.join(SCRIPT_DIR, "eng-oral-techniques.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-English-Oral-Analysis.docx");

const YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

// Hand-picked override per Peter — auto-prediction was OK but he wanted
// the doc to lead with these three topics (each backed by past-year
// evidence in the heatmap below).
const ORAL_PREDICTION_OVERRIDE =
  "Three hot topics most likely for the next PSLE oral:\n" +
  "  1.  School life / hobbies — perennial favourite, easy for any student to draw on.\n" +
  "  2.  Technology, especially AI / digital tools — covered in 2023 ('Fantastic Future' AI exhibition); examiners are returning to this as the topic matures.\n" +
  "  3.  Responsibility / time management — closely matches the Day 1 reading themes (Hakim's pacing, Jim's punctuality) and gives the student room to bring in personal anecdotes.\n" +
  "Prep these three with full PEEL drills before the exam.";

type OralTheme = {
  name: string; description: string;
  yearsAppeared: Array<{ year: string; day: 1 | 2; note: string }>;
  frequency: number;
};
type ThemesOutput = { overview: string; prediction: string; themes: OralTheme[] };

type PeelBreakdown = {
  questionType: string;
  pointPhrases: string[];
  explainPhrases: string[];
  examplePhrases: string[];
  linkPhrases: string[];
};
type SentenceStarter = { starter: string; example: string; whenToUse: string };
type Hedge = { phrase: string; meaning: string };
type TechniquesOutput = {
  peelOverview: string;
  peelByQuestionType: PeelBreakdown[];
  generalOpeners: SentenceStarter[];
  agreeStarters: SentenceStarter[];
  disagreeStarters: SentenceStarter[];
  personalAnecdote: string[];
  hedgesAndQualifiers: Hedge[];
  closingMoves: SentenceStarter[];
  upgradedExamples: Array<{ weak: string; strong: string; technique: string; highlight: string }>;
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
function bullet(text: string, opts?: { size?: number; bold?: boolean; italics?: boolean }) {
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

// Heatmap: themes × years, each cell shows which DAY (D1 / D2 / D1+D2)
// the theme was used. Visually denser than the compo heatmap.
function heatmapTable(themes: OralTheme[]): Table {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell("Theme", { bold: true, width: 30, bg: "FEF3C7", size: 18 }),
      cell("#", { bold: true, width: 6, bg: "FEF3C7", align: AlignmentType.CENTER, size: 18 }),
      ...YEARS.map(y => cell(y.slice(2), { bold: true, width: 6.4, bg: "FEF3C7", align: AlignmentType.CENTER, size: 18 })),
    ],
  });
  const rows = themes.map(theme => {
    const byYear = new Map<string, Set<1 | 2>>();
    for (const ya of theme.yearsAppeared) {
      const s = byYear.get(ya.year) ?? new Set<1 | 2>();
      s.add(ya.day);
      byYear.set(ya.year, s);
    }
    return new TableRow({
      children: [
        cell(theme.name, { size: 18 }),
        cell(String(theme.frequency), { bold: true, align: AlignmentType.CENTER, size: 18 }),
        ...YEARS.map(y => {
          const s = byYear.get(y);
          if (!s) return cell("", { align: AlignmentType.CENTER, bg: "F9FAFB", size: 18 });
          const label = s.has(1) && s.has(2) ? "D1+2" : s.has(1) ? "D1" : "D2";
          return cell(label, { align: AlignmentType.CENTER, bold: true, color: "92400E", bg: "FDE68A", size: 16 });
        }),
      ],
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [header, ...rows],
  });
}

function starterBlock(group: SentenceStarter[]): Paragraph[] {
  return group.flatMap(s => [
    new Paragraph({
      spacing: { before: 80, after: 20 },
      children: [t(s.starter, { bold: true, size: 22, color: "1E40AF" })],
    }),
    new Paragraph({
      indent: { left: 360 },
      spacing: { after: 20 },
      children: [t("e.g.  ", { italics: true, color: "6B7280", size: 20 }), t(s.example, { size: 22 })],
    }),
    new Paragraph({
      indent: { left: 360 },
      spacing: { after: 60 },
      children: [t("when to use:  ", { italics: true, color: "6B7280", size: 20 }), t(s.whenToUse, { italics: true, color: "4B5563", size: 20 })],
    }),
  ]);
}

async function main() {
  const themes = JSON.parse(await fs.readFile(THEMES_CACHE, "utf8")) as ThemesOutput;
  const techniques = JSON.parse(await fs.readFile(TECHNIQUES_CACHE, "utf8")) as TechniquesOutput;
  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(p("PSLE English Oral — 10-Year Analysis (2016-2025)", { heading: HeadingLevel.TITLE, align: AlignmentType.CENTER, after: 200 }));
  children.push(p("Paper 4 Stimulus-Based Conversation (SBC) • topic trends, PEEL technique, sentence variation", { italics: true, color: "6B7280", align: AlignmentType.CENTER, after: 300, size: 20 }));

  // §1 Heatmap
  children.push(p("§1  SBC Topic Heatmap", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("D1 / D2 marks which day of each year the topic appeared. D1+2 means both days touched the same theme.", { italics: true, color: "6B7280", size: 20, after: 80 }));
  children.push(heatmapTable(themes.themes));

  // §2 Overview + prediction
  children.push(p("§2  Overview & Likely Next Topic", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Overview", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(p(themes.overview, { size: 22, after: 120 }));
  children.push(p("Most likely SBC topics for next PSLE", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(new Paragraph({
    spacing: { after: 120 },
    shading: { type: ShadingType.CLEAR, fill: "FEF3C7", color: "auto" },
    children: [t(ORAL_PREDICTION_OVERRIDE, { size: 22, bold: true, color: "92400E" })],
  }));
  children.push(p("(For reference — the auto-generated prediction said:)", { italics: true, color: "9CA3AF", size: 18, before: 20, after: 20 }));
  children.push(p(themes.prediction, { italics: true, color: "9CA3AF", size: 18, after: 120 }));

  // §3 Per-theme detail
  children.push(p("§3  Per-Theme Detail", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  for (const th of themes.themes) {
    children.push(p(`${th.name}  (×${th.frequency})`, { bold: true, size: 22, before: 100, after: 30 }));
    children.push(p(th.description, { italics: true, color: "4B5563", size: 20, after: 40 }));
    for (const ya of th.yearsAppeared) {
      children.push(bullet(`${ya.year} • Day ${ya.day}: ${ya.note}`, { size: 20 }));
    }
  }

  // §4 PEEL technique
  children.push(p("§4  PEEL Technique — by question type", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p(techniques.peelOverview, { size: 22, after: 120 }));
  children.push(new Paragraph({
    spacing: { after: 120 },
    shading: { type: ShadingType.CLEAR, fill: "EDE9FE", color: "auto" },
    children: [
      t("PEEL  =  ", { bold: true, size: 22, color: "5B21B6" }),
      t("Point  →  Explain  →  Example  →  Link.", { size: 22 }),
      t("  State your view, give the reason, illustrate with a story or evidence, then close by looping back to the question.", { italics: true, color: "4B5563", size: 20 }),
    ],
  }));

  for (const qt of techniques.peelByQuestionType) {
    children.push(p(qt.questionType, { heading: HeadingLevel.HEADING_2, before: 200, after: 60 }));
    const peelRow = (label: string, color: string, phrases: string[]) => new TableRow({
      children: [
        cell(label, { bold: true, width: 12, bg: color, align: AlignmentType.CENTER, size: 18 }),
        new TableCell({
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          children: phrases.map(ph => new Paragraph({
            bullet: { level: 0 }, spacing: { before: 20, after: 20 },
            children: [t(ph, { size: 22 })],
          })),
        }),
      ],
    });
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorder(),
      rows: [
        peelRow("P — Point", "FECACA", qt.pointPhrases),
        peelRow("E — Explain", "FED7AA", qt.explainPhrases),
        peelRow("E — Example", "FEF08A", qt.examplePhrases),
        peelRow("L — Link", "D9F99D", qt.linkPhrases),
      ],
    }));
  }

  // §5 Sentence starters (alternatives to "I think")
  children.push(p('§5  Sentence Starters — anything but "I think..."', { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p('"I think" sounds tentative and gets repetitive. Use these alternatives — each comes with an example and when to use it.', { italics: true, color: "6B7280", size: 20, after: 80 }));

  children.push(p("General openers (start of any answer)", { heading: HeadingLevel.HEADING_2, before: 160, after: 40 }));
  children.push(...starterBlock(techniques.generalOpeners));

  children.push(p("Agreement — when you support the idea", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(...starterBlock(techniques.agreeStarters));

  children.push(p("Polite disagreement", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(...starterBlock(techniques.disagreeStarters));

  children.push(p("Bridging into a personal anecdote", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const ph of techniques.personalAnecdote) children.push(bullet(ph, { size: 22 }));

  children.push(p("Hedges & qualifiers (soften strong claims)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const h of techniques.hedgesAndQualifiers) {
    children.push(new Paragraph({
      bullet: { level: 0 },
      spacing: { before: 30, after: 30 },
      children: [
        t(h.phrase, { bold: true, color: "1E40AF", size: 22 }),
        t(" — ", { color: "9CA3AF", size: 22 }),
        t(h.meaning, { size: 22 }),
      ],
    }));
  }

  children.push(p("Closing moves (PEEL Link)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  children.push(...starterBlock(techniques.closingMoves));

  // §6 Weak → Strong upgrades
  children.push(p("§6  Weak ➜ Strong Upgrades", { heading: HeadingLevel.HEADING_1, before: 300, after: 120 }));
  children.push(p("Generic P5-level sentence fragments and the upgraded P6-distinction-level rewrites. The highlighted phrase is the key swap.", { italics: true, color: "6B7280", size: 20, after: 120 }));
  const svHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Weak", { bold: true, width: 35, bg: "FEE2E2" }),
      cell("Stronger", { bold: true, width: 50, bg: "D1FAE5" }),
      cell("Technique", { bold: true, width: 15, bg: "DBEAFE" }),
    ],
  });
  const svRows = techniques.upgradedExamples.map(ex => new TableRow({
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
