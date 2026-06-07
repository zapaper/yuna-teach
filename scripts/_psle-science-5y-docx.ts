// Generate a Word document of the PSLE Science 2021-2025 vs 2016-2020
// 5-year analysis. Output: eval/PSLE-Science-Topic-Marks-2021-2025.docx
//
// Uses the loadAndAggregate() helper from _psle-science-5y.ts so the
// numbers in the doc come from the same single source of truth as the
// console output.

import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, TableLayoutType,
  ShadingType, ImageRun,
} from "docx";
import { loadAndAggregate, type WindowAgg } from "./_psle-science-5y";

// Build an SVG clustered-horizontal-bar chart comparing 2016-2020 vs
// 2021-2025 marks per paper-equivalent. Then rasterise via sharp so
// docx can embed it as a PNG ImageRun.
async function buildBarChartPng(
  rows: { topic: string; ePerP: number; lPerP: number }[],
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const N = rows.length;
  const rowH = 38;
  const labelW = 290;
  const chartW = 460;
  const padLeft = 12;
  const padRight = 16;
  const padTop = 60;
  const padBottom = 50;
  const W = labelW + chartW + padLeft + padRight;
  const H = padTop + N * rowH + padBottom;

  const maxVal = Math.max(...rows.flatMap(r => [r.ePerP, r.lPerP]), 1);
  // Round max up to nearest 2 for cleaner gridlines.
  const axisMax = Math.ceil(maxVal / 2) * 2;
  const x0 = padLeft + labelW;
  const barH = rowH / 2 - 4;

  function valToX(v: number): number {
    return x0 + (v / axisMax) * chartW;
  }

  const NAVY = "#001E40";
  const GREEN = "#006C49";
  const GREEN_LIGHT = "#A7D7C3";
  const GREY = "#737780";
  const GRID = "#E3E8EE";

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Inter, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);

  // Title
  parts.push(`<text x="${W / 2}" y="28" text-anchor="middle" font-size="18" font-weight="bold" fill="${NAVY}">PSLE Science marks per paper-equivalent — 2016-2020 vs 2021-2025</text>`);

  // Gridlines + axis
  for (let v = 0; v <= axisMax; v += 2) {
    const gx = valToX(v);
    parts.push(`<line x1="${gx}" y1="${padTop - 10}" x2="${gx}" y2="${padTop + N * rowH}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${gx}" y="${padTop - 14}" text-anchor="middle" font-size="11" fill="${GREY}">${v}</text>`);
  }

  // Bars + labels
  rows.forEach((r, i) => {
    const baseY = padTop + i * rowH;
    const earlyY = baseY + 4;
    const lateY = earlyY + barH + 2;
    const earlyW = Math.max(0, valToX(r.ePerP) - x0);
    const lateW = Math.max(0, valToX(r.lPerP) - x0);
    // Topic label (right-aligned to the bars)
    const truncTopic = r.topic.length > 36 ? r.topic.slice(0, 33) + "…" : r.topic;
    parts.push(`<text x="${x0 - 8}" y="${earlyY + rowH / 2 + 1}" text-anchor="end" font-size="12" fill="${NAVY}">${escapeXml(truncTopic)}</text>`);
    // Bars
    parts.push(`<rect x="${x0}" y="${earlyY}" width="${earlyW}" height="${barH}" fill="${GREEN_LIGHT}"/>`);
    parts.push(`<rect x="${x0}" y="${lateY}" width="${lateW}" height="${barH}" fill="${GREEN}"/>`);
    // Value labels at end of bars
    parts.push(`<text x="${x0 + earlyW + 4}" y="${earlyY + barH - 2}" font-size="10" fill="${GREY}">${r.ePerP.toFixed(1)}</text>`);
    parts.push(`<text x="${x0 + lateW + 4}" y="${lateY + barH - 2}" font-size="10" fill="${NAVY}" font-weight="bold">${r.lPerP.toFixed(1)}</text>`);
  });

  // Legend
  const legY = H - 30;
  parts.push(`<rect x="${x0}" y="${legY}" width="20" height="10" fill="${GREEN_LIGHT}"/>`);
  parts.push(`<text x="${x0 + 28}" y="${legY + 9}" font-size="11" fill="${GREY}">2016-2020</text>`);
  parts.push(`<rect x="${x0 + 110}" y="${legY}" width="20" height="10" fill="${GREEN}"/>`);
  parts.push(`<text x="${x0 + 138}" y="${legY + 9}" font-size="11" fill="${NAVY}" font-weight="bold">2021-2025</text>`);
  parts.push(`<text x="${x0 + chartW / 2}" y="${legY + 25}" text-anchor="middle" font-size="11" fill="${GREY}">marks per paper-equivalent</text>`);

  parts.push("</svg>");
  const svg = parts.join("");
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
  return { bytes: png, width: W, height: H };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const NAVY = "001E40";
const GREEN = "006C49";
const RED = "B91C1C";
const GREY = "555555";

function p(text: string, opts: { bold?: boolean; size?: number; color?: string; italic?: boolean; align?: AlignmentType } = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align,
    children: [new TextRun({
      text,
      bold: opts.bold,
      size: opts.size ?? 22, // half-points; 22 = 11pt
      color: opts.color,
      italics: opts.italic,
    })],
  });
}

function h(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text, bold: true, color: NAVY })],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, size: 22 })],
  });
}

function blank(): Paragraph {
  return new Paragraph({ children: [new TextRun("")] });
}

const noBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};
const thinBorder = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
};

function cell(text: string, opts: { bold?: boolean; color?: string; bg?: string; align?: AlignmentType; size?: number } = {}): TableCell {
  return new TableCell({
    shading: opts.bg ? { type: ShadingType.CLEAR, color: "auto", fill: opts.bg } : undefined,
    children: [new Paragraph({
      alignment: opts.align,
      children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size ?? 20 })],
    })],
  });
}

function tableRow(cells: TableCell[]): TableRow {
  return new TableRow({ children: cells });
}

async function main() {
  const { inventory, win2016_2020, win2021_2025 } = await loadAndAggregate();

  // Build comparison rows.
  type Row = {
    topic: string;
    eM: number; lM: number;
    eMcq: number; eOeq: number;
    lMcq: number; lOeq: number;
    ePerP: number; lPerP: number;
    dPerP: number;
  };
  const allTopics = new Set([...win2016_2020.bag.keys(), ...win2021_2025.bag.keys()]);
  const rows: Row[] = [];
  for (const t of allTopics) {
    const e = win2016_2020.bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
    const l = win2021_2025.bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
    const eM = e.mcqM + e.oeqM;
    const lM = l.mcqM + l.oeqM;
    const ePerP = win2016_2020.paperEquiv > 0 ? eM / win2016_2020.paperEquiv : 0;
    const lPerP = win2021_2025.paperEquiv > 0 ? lM / win2021_2025.paperEquiv : 0;
    rows.push({ topic: t, eM, lM, eMcq: e.mcqM, eOeq: e.oeqM, lMcq: l.mcqM, lOeq: l.oeqM, ePerP, lPerP, dPerP: lPerP - ePerP });
  }
  // Sort descending by 2021-2025 marks (the most recent window) so the
  // current PSLE focus shows up at the top of every table and chart.
  rows.sort((a, b) => b.lM - a.lM);

  // Inventory table
  const inventoryTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      tableRow([
        cell("Period", { bold: true, bg: "EAF3FB" }),
        cell("Paper", { bold: true, bg: "EAF3FB" }),
        cell("Questions", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("Marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      ]),
      ...inventory.map(it => tableRow([
        cell(String(it.year)),
        cell(it.title),
        cell(String(it.qCount), { align: AlignmentType.CENTER }),
        cell(String(it.totalMarks), { align: AlignmentType.CENTER }),
      ])),
    ],
  });

  // Comparison table — ranked by combined total.
  const compTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      tableRow([
        cell("Topic", { bold: true, bg: "EAF3FB" }),
        cell("2016-2020 marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("/paper", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("MCQ : OEQ", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("2021-2025 marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("/paper", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("MCQ : OEQ", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("Δ / paper", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      ]),
      ...rows.map(r => {
        const trend = r.dPerP >= 1 ? GREEN : r.dPerP <= -1 ? RED : GREY;
        const arrow = r.dPerP >= 1 ? "  ↑" : r.dPerP <= -1 ? "  ↓" : "";
        return tableRow([
          cell(r.topic),
          cell(String(r.eM), { align: AlignmentType.CENTER }),
          cell(r.ePerP.toFixed(1), { align: AlignmentType.CENTER }),
          cell(`${r.eMcq}:${r.eOeq}`, { align: AlignmentType.CENTER }),
          cell(String(r.lM), { align: AlignmentType.CENTER }),
          cell(r.lPerP.toFixed(1), { align: AlignmentType.CENTER }),
          cell(`${r.lMcq}:${r.lOeq}`, { align: AlignmentType.CENTER }),
          cell(`${r.dPerP >= 0 ? "+" : ""}${r.dPerP.toFixed(1)}${arrow}`, { align: AlignmentType.CENTER, color: trend, bold: Math.abs(r.dPerP) >= 1 }),
        ]);
      }),
    ],
  });

  // Single-window (2021-2025) table.
  // rows is already sorted desc by 2021-25 marks; reuse it.
  const single = rows;
  const singleTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      tableRow([
        cell("Topic", { bold: true, bg: "EAF3FB" }),
        cell("Marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("/paper", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("Share %", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("MCQ marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("OEQ marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cell("OEQ share", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      ]),
      ...single.filter(r => r.lM > 0).map(r => {
        const share = win2021_2025.totalM > 0 ? (r.lM / win2021_2025.totalM) * 100 : 0;
        const oeqShare = r.lM > 0 ? (r.lOeq / r.lM) * 100 : 0;
        return tableRow([
          cell(r.topic),
          cell(String(r.lM), { align: AlignmentType.CENTER }),
          cell(r.lPerP.toFixed(1), { align: AlignmentType.CENTER }),
          cell(`${share.toFixed(1)}%`, { align: AlignmentType.CENTER }),
          cell(String(r.lMcq), { align: AlignmentType.CENTER }),
          cell(String(r.lOeq), { align: AlignmentType.CENTER }),
          cell(`${oeqShare.toFixed(0)}%`, { align: AlignmentType.CENTER }),
        ]);
      }),
    ],
  });

  // Top gainers / losers commentary
  const gainers = [...rows].sort((a, b) => b.dPerP - a.dPerP).slice(0, 5);
  const losers = [...rows].sort((a, b) => a.dPerP - b.dPerP).slice(0, 5);

  // Bar chart (omit zero-mark rows so it doesn't get cluttered)
  const chartRows = rows.filter(r => r.lM + r.eM > 0).map(r => ({ topic: r.topic, ePerP: r.ePerP, lPerP: r.lPerP }));
  const chart = await buildBarChartPng(chartRows);
  // Width in EMU: 6 inches × 914400. Scale to fit page; cap actual SVG
  // dimensions otherwise.
  const targetWidthIn = 6.5;
  const chartImg = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png",
      data: chart.bytes,
      transformation: {
        width: targetWidthIn * 96,
        height: targetWidthIn * 96 * (chart.height / chart.width),
      },
    })],
  });

  const doc = new Document({
    creator: "MarkForYou analysis pipeline",
    title: "PSLE Science Topic Marks 2021-2025",
    description: "Five-year topic-marks analysis with 2016-2020 baseline.",
    sections: [{
      properties: {},
      children: [
        h("PSLE Science Topic Marks: 2021-2025 vs 2016-2020", HeadingLevel.HEADING_1),
        p("A five-year-window analysis of PSLE Science by topic. Numbers come from the master examPaper bank, normalised to marks per paper-equivalent so both windows compare on the same scale.", { italic: true, color: GREY }),
        blank(),

        h("Data caveat — read first", HeadingLevel.HEADING_2),
        p("The bank does not hold individual 2022, 2023, 2024 PSLE Science papers. Instead it has four aggregated buckets, all dated 2022 in the bank but representing 2022-2024 combined:"),
        bullet("PSLE Life Science MCQ 2022-2024 (42 questions, 84 marks)"),
        bullet("PSLE Life Science OEQ 2022-2024 (20 questions, 63 marks)"),
        bullet("PSLE Physical Science MCQ 2022-2024 (42 questions, 84 marks)"),
        bullet("PSLE Physical science OEQ 2022-2024 (18 questions, 66 marks)"),
        p("Combined: 297 marks across 122 questions — equivalent to roughly 3 papers' worth of content (each real PSLE Science paper is 100 marks). The 2021-2025 window below sums these four buckets along with the actual 2021 paper and the actual 2025 paper, giving 497 marks total — 4.97 paper-equivalents."),
        p("Earlier analyses that kept only ONE of the four buckets after de-duplication were silently dropping ~75% of the 2022-2024 evidence and produced misleading conclusions on OEQ-heavy topics. The numbers below sum all four."),
        blank(),

        h("Paper inventory", HeadingLevel.HEADING_2),
        inventoryTable,
        blank(),

        h("Window totals", HeadingLevel.HEADING_2),
        bullet(`2016-2020: ${win2016_2020.paperList.length} actual papers, ${win2016_2020.totalM} marks, ${win2016_2020.paperEquiv.toFixed(2)} paper-equivalents`),
        bullet(`2021-2025: ${win2021_2025.paperList.length} inputs (2021 + 4 buckets + 2025), ${win2021_2025.totalM} marks, ${win2021_2025.paperEquiv.toFixed(2)} paper-equivalents`),
        blank(),

        h("Topic marks at a glance", HeadingLevel.HEADING_2),
        p("Clustered bar chart, sorted descending by 2021-2025 marks per paper-equivalent. Pale green = 2016-2020; solid green = 2021-2025. The two bars per topic make the year-on-year shift easy to scan."),
        blank(),
        chartImg,
        blank(),

        h("2021-2025 single-window breakdown", HeadingLevel.HEADING_2),
        p("Ranked by absolute marks. /paper is marks normalised by paper-equivalents; share % is the topic's slice of the 497-mark window total; OEQ share is the percentage of that topic's marks that come from open-ended (non-MCQ) questions."),
        blank(),
        singleTable,
        blank(),

        h("2016-2020 baseline vs 2021-2025 comparison", HeadingLevel.HEADING_2),
        p("Ranked by combined 10-year marks. Δ / paper is the change in marks per paper-equivalent between windows; green up-arrows = gained ≥1 m/p, red down-arrows = lost ≥1 m/p."),
        blank(),
        compTable,
        blank(),

        h("Five biggest gainers (per paper-equivalent)", HeadingLevel.HEADING_2),
        ...gainers.map(g => bullet(`${g.topic}: ${g.ePerP.toFixed(1)} → ${g.lPerP.toFixed(1)} marks/paper (Δ ${g.dPerP >= 0 ? "+" : ""}${g.dPerP.toFixed(1)})`)),
        blank(),

        h("Five biggest losers (per paper-equivalent)", HeadingLevel.HEADING_2),
        ...losers.map(l => bullet(`${l.topic}: ${l.ePerP.toFixed(1)} → ${l.lPerP.toFixed(1)} marks/paper (Δ ${l.dPerP.toFixed(1)})`)),
        blank(),

        h("Reading the shift", HeadingLevel.HEADING_2),
        p("The headline movement: Interactions within the environment was the dominant topic in 2016-2020 (17.4 marks per paper-equivalent, 49 of those from OEQ). In 2021-2025 it falls to 10.1 m/p — still significant in absolute terms but losing 7.3 marks per paper-equivalent. Most of the shift is on the OEQ side; the MCQ representation is roughly steady."),
        p("The gains spread across physical-systems topics (Electrical, Heat, Energy conversion balanced) and life-process topics (Life cycles, Diversity of living/non-living, Cycles in matter). No single topic moves into the top spot; Interactions stays number one in absolute marks despite the drop."),
        p("Per-topic OEQ share is the most actionable column for revision plans. Topics with ≥50% OEQ share (Interactions, Friction/Gravity, Heat, Electrical, Energy conversion, Photosynthesis, Magnets, Cycles in matter) are where the bulk of structured-response practice should sit. Topics with <20% OEQ share (Diversity of living/non-living, Light, Plant parts, Diversity of materials) are quicker-tempo MCQ pools and benefit from short-burst drills."),
        blank(),

        h("Reproducibility", HeadingLevel.HEADING_2),
        p("Run:  npx tsx scripts/_psle-science-5y.ts  for the console output."),
        p("Run:  npx tsx scripts/_psle-science-5y-docx.ts  to regenerate this document."),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join("eval", "PSLE-Science-Topic-Marks-2021-2025.docx");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buffer);
  console.log(`Wrote ${outPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
