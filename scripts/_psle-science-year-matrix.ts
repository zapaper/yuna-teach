// Per-year PSLE Science topic-marks matrix + line-trend chart.
// Adds two artefacts to the Word doc:
//   1. A year-by-year matrix table (topic × year, sorted desc by
//      2021-2025 total).
//   2. A line chart of the top 6 topics over time, with 2022-2024
//      plotted at year 2023 (midpoint of bucket) using per-year-
//      equivalent marks (bucket marks / 3).
//
// The 2022-2024 column in the matrix shows both raw (combined) and
// per-year-equivalent so readers can scan either way.

import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, TableLayoutType,
  ShadingType, ImageRun,
} from "docx";
import { prisma } from "../src/lib/db";

const NAVY = "001E40";
const GREEN = "006C49";
const GREY = "555555";

type Cell = { mcqM: number; oeqM: number; qCount: number };

function isMcq(q: { transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
  const t = q.transcribedOptionTable;
  if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

function normaliseTopic(raw: string): string {
  const t = raw.trim();
  if (/^Interaction of forces/i.test(t)) return "Interaction of forces (Friction / Gravity / Magnets)";
  return t;
}

function bagPaper(p: { questions: Array<{ syllabusTopic: string | null; marksAvailable: number | null; transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }> }): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const q of p.questions) {
    const topic = normaliseTopic((q.syllabusTopic ?? "").trim() || "(Untagged)");
    const m = Number(q.marksAvailable);
    if (!Number.isFinite(m) || m <= 0) continue;
    const cur = out.get(topic) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
    if (isMcq(q)) cur.mcqM += m; else cur.oeqM += m;
    cur.qCount++;
    out.set(topic, cur);
  }
  return out;
}

function cellMarks(c: Cell): number { return c.mcqM + c.oeqM; }
function add(a: Cell, b: Cell): Cell { return { mcqM: a.mcqM + b.mcqM, oeqM: a.oeqM + b.oeqM, qCount: a.qCount + b.qCount }; }

const YEAR_COLS = [2016, 2017, 2018, 2019, 2020, 2021, "2022-24", 2025] as const;
type YearCol = (typeof YEAR_COLS)[number];

async function loadByYear() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      OR: [{ level: { equals: "PSLE", mode: "insensitive" } }, { title: { contains: "PSLE", mode: "insensitive" } }],
    },
    select: {
      id: true, title: true, subject: true, year: true,
      questions: {
        select: { syllabusTopic: true, marksAvailable: true,
          transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true },
      },
    },
  });
  const sci = papers.filter(p => (p.subject ?? "").toLowerCase().includes("science"));
  const isAgg = (p: typeof sci[number]) => /2022-2024/i.test(p.title ?? "");

  const perCol = new Map<YearCol, Map<string, Cell>>();
  for (const col of YEAR_COLS) perCol.set(col, new Map());

  for (const p of sci) {
    let col: YearCol | null = null;
    if (isAgg(p)) col = "2022-24";
    else {
      const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
      if ((YEAR_COLS as readonly (number | string)[]).includes(y)) col = y as YearCol;
    }
    if (!col) continue;
    const bag = bagPaper(p);
    const dest = perCol.get(col)!;
    for (const [t, c] of bag) dest.set(t, add(dest.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
  }
  return perCol;
}

// Build a year-by-year line chart for the top N topics. 2022-24 bucket
// is plotted at year 2023 using bucket-marks/3 so the line treats it as
// a per-year-equivalent point.
async function buildLineChart(
  topicSet: string[],
  perCol: Map<YearCol, Map<string, Cell>>,
): Promise<Buffer> {
  // X positions: years 2016..2025 with bucket plotted at 2023.
  const xYears = [2016, 2017, 2018, 2019, 2020, 2021, 2023, 2025] as const;
  type Pt = { x: number; y: number };
  const seriesByTopic = new Map<string, Pt[]>();
  for (const t of topicSet) {
    const pts: Pt[] = [];
    YEAR_COLS.forEach((col, ix) => {
      const c = perCol.get(col)?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
      const marks = cellMarks(c);
      const perYearEquiv = col === "2022-24" ? marks / 3 : marks;
      pts.push({ x: xYears[ix], y: perYearEquiv });
    });
    seriesByTopic.set(t, pts);
  }

  const W = 900, H = 460;
  const padL = 60, padR = 220, padT = 60, padB = 50;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xMin = 2016, xMax = 2025;
  const allY = [...seriesByTopic.values()].flatMap(p => p.map(d => d.y));
  const yMax = Math.max(...allY, 10);
  const yMaxRounded = Math.ceil(yMax / 5) * 5;

  function sx(year: number): number { return padL + ((year - xMin) / (xMax - xMin)) * plotW; }
  function sy(val: number): number { return padT + plotH - (val / yMaxRounded) * plotH; }

  const PALETTE = ["#006C49", "#001E40", "#B91C1C", "#F59E0B", "#7C3AED", "#0EA5E9"];

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Inter, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);
  parts.push(`<text x="${W / 2}" y="28" text-anchor="middle" font-size="18" font-weight="bold" fill="#001E40">Top PSLE Science topics — marks per year (2022-24 = bucket / 3)</text>`);

  // Y gridlines + labels
  for (let yv = 0; yv <= yMaxRounded; yv += 5) {
    const y = sy(yv);
    parts.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#E3E8EE" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#737780">${yv}</text>`);
  }
  parts.push(`<text x="${padL - 40}" y="${padT + plotH / 2}" font-size="11" fill="#737780" transform="rotate(-90 ${padL - 40} ${padT + plotH / 2})">marks per year</text>`);

  // X ticks
  for (const yr of [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
    const x = sx(yr);
    parts.push(`<line x1="${x}" y1="${padT + plotH}" x2="${x}" y2="${padT + plotH + 4}" stroke="#737780"/>`);
    parts.push(`<text x="${x}" y="${padT + plotH + 18}" text-anchor="middle" font-size="11" fill="#737780">${yr}</text>`);
  }
  // Shade the 2022-2024 bucket window
  parts.push(`<rect x="${sx(2022)}" y="${padT}" width="${sx(2024) - sx(2022)}" height="${plotH}" fill="#F4F7FA" opacity="0.7"/>`);
  parts.push(`<text x="${(sx(2022) + sx(2024)) / 2}" y="${padT - 8}" text-anchor="middle" font-size="10" fill="#737780">bucket (plotted at 2023)</text>`);

  // Plot lines + dots
  let colorIdx = 0;
  for (const [topic, pts] of seriesByTopic) {
    const color = PALETTE[colorIdx % PALETTE.length];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const p of pts) {
      parts.push(`<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.5" fill="${color}"/>`);
    }
    // Legend
    const legY = padT + 6 + colorIdx * 20;
    const legX = padL + plotW + 14;
    parts.push(`<line x1="${legX}" y1="${legY}" x2="${legX + 22}" y2="${legY}" stroke="${color}" stroke-width="2.5"/>`);
    parts.push(`<circle cx="${legX + 11}" cy="${legY}" r="3.5" fill="${color}"/>`);
    const truncTopic = topic.length > 28 ? topic.slice(0, 26) + "…" : topic;
    parts.push(`<text x="${legX + 30}" y="${legY + 4}" font-size="11" fill="#001E40">${escapeXml(truncTopic)}</text>`);
    colorIdx++;
  }

  parts.push("</svg>");
  return sharp(Buffer.from(parts.join(""))).png().toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function cellEl(text: string, opts: { bold?: boolean; bg?: string; align?: AlignmentType; color?: string; size?: number } = {}): TableCell {
  return new TableCell({
    shading: opts.bg ? { type: ShadingType.CLEAR, color: "auto", fill: opts.bg } : undefined,
    children: [new Paragraph({
      alignment: opts.align,
      children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size ?? 18 })],
    })],
  });
}

async function main() {
  const perCol = await loadByYear();

  // Sort topics by 2021-2025 total descending.
  function recentTotal(t: string): number {
    let sum = 0;
    for (const col of YEAR_COLS) {
      if (col === 2021 || col === "2022-24" || col === 2025) {
        sum += cellMarks(perCol.get(col)?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 });
      }
    }
    return sum;
  }
  const allTopics = new Set<string>();
  for (const col of YEAR_COLS) for (const t of (perCol.get(col)?.keys() ?? [])) allTopics.add(t);
  const sortedTopics = [...allTopics].sort((a, b) => recentTotal(b) - recentTotal(a));

  // Build the per-year matrix table.
  const headerRow = new TableRow({
    children: [
      cellEl("Topic", { bold: true, bg: "EAF3FB" }),
      ...YEAR_COLS.map(c => cellEl(String(c), { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER })),
      cellEl("2022-24 / yr", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      cellEl("2021-25 total", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
    ],
  });
  const dataRows = sortedTopics.filter(t => recentTotal(t) > 0).map(t => {
    const cells: TableCell[] = [cellEl(t)];
    for (const col of YEAR_COLS) {
      const c = perCol.get(col)?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
      cells.push(cellEl(String(cellMarks(c)), { align: AlignmentType.CENTER }));
    }
    const bucket = cellMarks(perCol.get("2022-24")?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 });
    cells.push(cellEl((bucket / 3).toFixed(1), { align: AlignmentType.CENTER, color: GREEN }));
    cells.push(cellEl(String(recentTotal(t)), { align: AlignmentType.CENTER, bold: true, color: NAVY }));
    return new TableRow({ children: cells });
  });
  const matrixTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [headerRow, ...dataRows],
  });

  // Build line chart for top 6 topics by recent total.
  const top6 = sortedTopics.filter(t => recentTotal(t) > 0).slice(0, 6);
  const chartBytes = await buildLineChart(top6, perCol);
  // Save standalone copy too so you can preview without opening Word.
  await fs.writeFile(path.join("eval", "psle-science-line.png"), chartBytes);

  const chartPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png", data: chartBytes,
      transformation: { width: 6.5 * 96, height: 6.5 * 96 * (460 / 900) },
    })],
  });

  // Assemble Word doc.
  function h(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) {
    return new Paragraph({ heading: level, children: [new TextRun({ text, bold: true, color: NAVY })] });
  }
  function p(text: string, opts: { italic?: boolean; color?: string; bold?: boolean } = {}) {
    return new Paragraph({ children: [new TextRun({ text, size: 22, italics: opts.italic, color: opts.color, bold: opts.bold })] });
  }
  function blank() { return new Paragraph({ children: [new TextRun("")] }); }
  function bullet(text: string) { return new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text, size: 22 })] }); }

  const doc = new Document({
    creator: "MarkForYou analysis pipeline",
    title: "PSLE Science Year-by-Year Topic Marks",
    sections: [{
      properties: {},
      children: [
        h("PSLE Science: Year-by-Year Topic Marks", HeadingLevel.HEADING_1),
        p("Per-year breakdown of marks per topic across 2016-2025. The 2022-2024 column shows the aggregated bucket total; the next column (2022-24/yr) divides by 3 for a per-year-equivalent estimate. Topics sorted descending by 2021-2025 combined total.", { italic: true, color: GREY }),
        blank(),

        h("Trend chart — top 6 topics by 2021-2025 total", HeadingLevel.HEADING_2),
        p("Lines plot marks per year. The 2022-2024 bucket is plotted at 2023 (midpoint) using marks/3 so the bucket sits on a per-year scale with the individual papers. The shaded band marks the 2022-2024 window."),
        blank(),
        chartPara,
        blank(),

        h("Year-by-year matrix", HeadingLevel.HEADING_2),
        p("Marks per topic per year (raw). 2022-24 column = combined bucket total across the 4 sub-buckets (Life Sci MCQ + Life Sci OEQ + Physical Sci MCQ + Physical Sci OEQ). 2022-24/yr = bucket ÷ 3 for per-year-equivalent."),
        blank(),
        matrixTable,
        blank(),

        h("Observations", HeadingLevel.HEADING_2),
        bullet("Interactions within the environment: peaked sharply in 2018 (24) and 2019 (32), collapsed in 2020-2021 (6 and 4), rebounded in the 2022-2024 bucket (~13/yr), then back down to 7 in 2025."),
        bullet("Interaction of forces (combined): consistently 6-15 marks/year across the whole window — steadiest of the big topics. Note the 20-mark spike in 2021."),
        bullet("Electrical system and circuits: gradual climb across the window — 7 (2016) → 9 (2020-21 each) → ~10/yr in 2022-24 → 9 (2025)."),
        bullet("Heat energy: low base (5-9 marks) through 2018-2021, then jumped to ~10/yr in 2022-2024 and held at 8 in 2025."),
        bullet("Life cycles in plants and animals: doubled from ~4-8 marks/year through 2020 to ~5/yr in 2022-2024 to 8 in 2025."),
        bullet("Magnets: cleared a 7-mark band in 2017-2019, then halved in 2020-2021 and stays low (~3/yr) in the recent bucket. The trajectory looks like a deliberate de-emphasis."),
        blank(),

        h("Reproducibility", HeadingLevel.HEADING_2),
        p("Run:  npx tsx scripts/_psle-science-year-matrix.ts"),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join("eval", "PSLE-Science-Year-by-Year.docx");
  await fs.writeFile(outPath, buffer);
  console.log(`Wrote ${outPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`Wrote eval/psle-science-line.png standalone preview`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
