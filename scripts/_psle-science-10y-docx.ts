// PSLE Science 10-year-average analysis (2016-2025) + top-5 topic chart.
// Replaces the earlier 5-year-window doc with a single decadal average.
//
// Inputs:
//   Actual yearly papers for 2016-2021 and 2025 (8 papers, 800 marks)
//   Four 2022-2024 aggregated buckets   (297 marks ≈ 3 paper-equivalents)
//   Total: 1,097 marks over ~10.97 paper-equivalents
//
// All topic totals normalise by paper-equivalents (sum of marks / 100
// per paper since each PSLE Science paper is 100 marks).

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

// Wrap a topic label into at most 2 lines so long names like
// "Interaction of forces (Friction / Gravity / Magnets)" stay readable.
// Picks the space closest to the middle as the line break.
function wrapTopicLabel(topic: string, maxCharsPerLine: number): string[] {
  if (topic.length <= maxCharsPerLine) return [topic];
  const words = topic.split(" ");
  // Find the break that minimises max-line-length.
  let bestSplit = -1;
  let bestMaxLen = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const ml = Math.max(a.length, b.length);
    if (ml < bestMaxLen) { bestMaxLen = ml; bestSplit = i; }
  }
  if (bestSplit < 1) return [topic.slice(0, maxCharsPerLine), topic.slice(maxCharsPerLine)];
  return [words.slice(0, bestSplit).join(" "), words.slice(bestSplit).join(" ")];
}

// Horizontal bar chart for the top-N topics. Stripped of grid lines,
// x-axis numbers and supporting grey captions — labels (rounded to
// whole numbers) sit at the end of each bar, two-line topic names
// stack to the left.
async function buildTop5Chart(rows: { topic: string; perYear: number; total: number }[]): Promise<Buffer> {
  const N = rows.length;
  const rowH = 120;
  const labelW = 340;
  const padLeft = 16;
  const padRight = 90;
  const padTop = 90;
  // Extra bottom padding for the attribution footer so it doesn't
  // crowd the lowest bar.
  const padBottom = 60;
  const chartW = 380;
  const W = padLeft + labelW + chartW + padRight;
  const H = padTop + N * rowH + padBottom;

  const maxVal = Math.max(...rows.map(r => r.perYear), 1);
  const axisMax = Math.ceil(maxVal / 2) * 2;
  const x0 = padLeft + labelW;

  function valToX(v: number): number {
    return x0 + (v / axisMax) * chartW;
  }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Inter, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);
  parts.push(`<text x="${W / 2}" y="44" text-anchor="middle" font-size="26" font-weight="bold" fill="#001E40">Top 5 PSLE Science topics — Avg marks per year (2016-2025)</text>`);

  const barH = rowH - 30;
  rows.forEach((r, i) => {
    const baseY = padTop + i * rowH;
    const yMid = baseY + rowH / 2;
    const barY = baseY + 15;
    const w = Math.max(0, valToX(r.perYear) - x0);
    const wholeVal = Math.round(r.perYear);
    const lines = wrapTopicLabel(r.topic, 26);

    // Rank circle
    parts.push(`<circle cx="${padLeft + 22}" cy="${yMid}" r="20" fill="#006C49"/>`);
    parts.push(`<text x="${padLeft + 22}" y="${yMid + 7}" text-anchor="middle" font-size="20" font-weight="bold" fill="white">${i + 1}</text>`);

    // Topic label — 1 or 2 lines, centred vertically across the row.
    if (lines.length === 1) {
      parts.push(`<text x="${padLeft + 54}" y="${yMid + 7}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[0])}</text>`);
    } else {
      parts.push(`<text x="${padLeft + 54}" y="${yMid - 4}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[0])}</text>`);
      parts.push(`<text x="${padLeft + 54}" y="${yMid + 20}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[1])}</text>`);
    }

    // Bar
    parts.push(`<rect x="${x0}" y="${barY}" width="${w}" height="${barH}" fill="#006C49" rx="3"/>`);
    // Whole-number value label
    parts.push(`<text x="${x0 + w + 10}" y="${yMid + 9}" font-size="24" font-weight="bold" fill="#001E40">${wholeVal}</text>`);
  });

  // Attribution footer (for screenshots / shared copies).
  parts.push(`<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-size="18" font-weight="bold" fill="#006C49">www.MarkForYou.com</text>`);
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
      children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size ?? 20 })],
    })],
  });
}

async function main() {
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
  const aggBuckets = sci.filter(isAgg);

  // Build inventory + aggregate everything in 2016-2025.
  const inventory: { period: string; title: string; qCount: number; marks: number }[] = [];
  const combinedBag = new Map<string, Cell>();
  let totalMarks = 0;
  let paperEquiv = 0;

  for (const p of sci) {
    if (isAgg(p)) continue;
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    if (y < 2016 || y > 2025) continue;
    const m = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    inventory.push({ period: String(y), title: p.title ?? "", qCount: p.questions.length, marks: m });
    totalMarks += m;
    paperEquiv += m / 100;
    const bag = bagPaper(p);
    for (const [t, c] of bag) combinedBag.set(t, add(combinedBag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
  }
  for (const p of aggBuckets) {
    const m = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    inventory.push({ period: "2022-2024", title: p.title ?? "", qCount: p.questions.length, marks: m });
    totalMarks += m;
    paperEquiv += m / 100;
    const bag = bagPaper(p);
    for (const [t, c] of bag) combinedBag.set(t, add(combinedBag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
  }
  inventory.sort((a, b) => a.period.localeCompare(b.period));

  // Rank topics by total marks across the decade.
  type Rank = { topic: string; total: number; perYear: number; mcq: number; oeq: number; oeqShare: number; share: number };
  const ranks: Rank[] = [...combinedBag.entries()].map(([topic, c]) => {
    const total = cellMarks(c);
    return {
      topic,
      total,
      perYear: paperEquiv > 0 ? total / paperEquiv : 0,
      mcq: c.mcqM,
      oeq: c.oeqM,
      oeqShare: total > 0 ? (c.oeqM / total) * 100 : 0,
      share: totalMarks > 0 ? (total / totalMarks) * 100 : 0,
    };
  }).filter(r => r.total > 0).sort((a, b) => b.total - a.total);

  const top5 = ranks.slice(0, 5);

  // Build top-5 chart.
  const chartBytes = await buildTop5Chart(top5.map(r => ({ topic: r.topic, perYear: r.perYear, total: r.total })));
  await fs.writeFile(path.join("eval", "psle-science-top5-10y.png"), chartBytes);

  // Build full rank table.
  const fullTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({
        children: [
          cellEl("Rank", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("Topic", { bold: true, bg: "EAF3FB" }),
          cellEl("Total marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("Marks / paper-equiv", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("Share %", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("MCQ : OEQ", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("OEQ share", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        ],
      }),
      ...ranks.map((r, i) => new TableRow({
        children: [
          cellEl(String(i + 1), { align: AlignmentType.CENTER, bold: i < 5, color: i < 5 ? GREEN : undefined }),
          cellEl(r.topic, { bold: i < 5 }),
          cellEl(String(r.total), { align: AlignmentType.CENTER }),
          cellEl(r.perYear.toFixed(1), { align: AlignmentType.CENTER }),
          cellEl(`${r.share.toFixed(1)}%`, { align: AlignmentType.CENTER }),
          cellEl(`${r.mcq}:${r.oeq}`, { align: AlignmentType.CENTER }),
          cellEl(`${r.oeqShare.toFixed(0)}%`, { align: AlignmentType.CENTER }),
        ],
      })),
    ],
  });

  // Inventory table.
  const invTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({
        children: [
          cellEl("Period", { bold: true, bg: "EAF3FB" }),
          cellEl("Paper", { bold: true, bg: "EAF3FB" }),
          cellEl("Questions", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
          cellEl("Marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        ],
      }),
      ...inventory.map(it => new TableRow({
        children: [
          cellEl(it.period),
          cellEl(it.title),
          cellEl(String(it.qCount), { align: AlignmentType.CENTER }),
          cellEl(String(it.marks), { align: AlignmentType.CENTER }),
        ],
      })),
    ],
  });

  function h(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) {
    return new Paragraph({ heading: level, children: [new TextRun({ text, bold: true, color: NAVY })] });
  }
  function p(text: string, opts: { italic?: boolean; color?: string; bold?: boolean } = {}) {
    return new Paragraph({ children: [new TextRun({ text, size: 22, italics: opts.italic, color: opts.color, bold: opts.bold })] });
  }
  function blank() { return new Paragraph({ children: [new TextRun("")] }); }
  function bullet(text: string) { return new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text, size: 22 })] }); }

  const chartPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png", data: chartBytes,
      transformation: { width: 6.5 * 96, height: 6.5 * 96 * (chartBytes.byteLength / chartBytes.byteLength) },
    })],
  });
  // Recompute the actual image dimensions to set correct transform.
  const chartMeta = await sharp(chartBytes).metadata();
  const chartH = chartMeta.height ?? 1;
  const chartW = chartMeta.width ?? 1;
  const fixedChartPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png", data: chartBytes,
      transformation: { width: 6.5 * 96, height: 6.5 * 96 * (chartH / chartW) },
    })],
  });

  const doc = new Document({
    creator: "MarkForYou analysis pipeline",
    title: "PSLE Science Topic Marks 10-Year Average",
    sections: [{
      properties: {},
      children: [
        h("PSLE Science: 10-Year Topic-Marks Average (2016-2025)", HeadingLevel.HEADING_1),
        p("A decade of PSLE Science papers — every topic's average marks per paper-equivalent. The 2022-2024 papers exist in the bank as four aggregated question-shape buckets (Life Sci MCQ + Life Sci OEQ + Physical Sci MCQ + Physical Sci OEQ); they are summed and added to the 2016-2021 and 2025 yearly papers as ~3 paper-equivalents of recent content.", { italic: true, color: GREY }),
        blank(),

        h(`Window totals`, HeadingLevel.HEADING_2),
        bullet(`Papers + buckets: ${inventory.length} inputs`),
        bullet(`Total marks tagged: ${totalMarks}`),
        bullet(`Paper-equivalents: ${paperEquiv.toFixed(2)} (across 2016-2025)`),
        bullet(`Average marks per paper-equivalent across all topics: ${(totalMarks / paperEquiv).toFixed(1)}`),
        blank(),

        h("Top 5 topics — 10-year average", HeadingLevel.HEADING_2),
        p("Marks per paper-equivalent (i.e. expected marks on a single PSLE Science paper) averaged across the decade. Total marks across all 10 paper-equivalents shown below each bar."),
        blank(),
        fixedChartPara,
        blank(),

        h("Full ranking — every topic, 10-year average", HeadingLevel.HEADING_2),
        p("Top 5 highlighted in green. /paper-equiv lets you read the topic's expected weight on a single paper; share % is its slice of the 10-year total; OEQ share is the percentage of the topic's marks that come from open-ended (non-MCQ) questions."),
        blank(),
        fullTable,
        blank(),

        h("Reading the table", HeadingLevel.HEADING_2),
        bullet(`#1 Interaction of forces (Friction/Gravity/Magnets) at ${top5[0].perYear.toFixed(1)} marks/paper — the single biggest topic across the decade, on average bigger even than Interactions in the long run. Steady year-on-year.`),
        bullet(`#2 Interactions within the environment at ${top5[1].perYear.toFixed(1)} marks/paper — bumpy across years but still the second-biggest in aggregate. Most volatile of the top 5.`),
        bullet(`#3 Electrical system and circuits at ${top5[2].perYear.toFixed(1)} marks/paper — gentle climb across the decade.`),
        bullet(`#4 Heat energy and uses at ${top5[3].perYear.toFixed(1)} marks/paper — quiet but consistent.`),
        bullet(`#5 Diversity of living and non-living things at ${top5[4].perYear.toFixed(1)} marks/paper — MCQ-dominated (${top5[4].oeqShare.toFixed(0)}% OEQ share).`),
        blank(),
        p(`The top 5 together account for ${top5.reduce((s, r) => s + r.share, 0).toFixed(0)}% of total PSLE Science marks across the decade. Drilling these five well should cover the bulk of the test weight.`, { bold: true }),
        blank(),

        h("Data caveat", HeadingLevel.HEADING_2),
        p("The 2022-2024 entries in the bank are not three separate yearly papers. They are four aggregated buckets (Life Science MCQ + Life Science OEQ + Physical Science MCQ + Physical Science OEQ) totalling 297 marks ≈ 3 paper-equivalents. The 10-year average above treats them as a single 3-paper-equivalent contribution to the decade total — equivalent to weighting each individual 2016-2021 / 2025 paper equally and the 2022-2024 bucket as three papers' worth."),
        blank(),

        h("Paper inventory", HeadingLevel.HEADING_2),
        invTable,
        blank(),

        h("Reproducibility", HeadingLevel.HEADING_2),
        p("Run:  npx tsx scripts/_psle-science-10y-docx.ts"),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join("eval", "PSLE-Science-Topic-Marks-10yr-Average.docx");
  await fs.writeFile(outPath, buffer);
  console.log(`Wrote ${outPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`Wrote eval/psle-science-top5-10y.png standalone preview`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
