// PSLE Math 10-year analysis (2016-2025) + Top-5 chart + per-year matrix.
//
// Inventory: 10 actual yearly papers, 100 marks each, no aggregated
// buckets (unlike Science). Topic merges:
//   - "Basic Math Operations" + "Basic math operations" → one row
//     (the casing mismatch was an extraction tagging slip)
//
// Output:
//   eval/PSLE-Math-Topic-Marks-2016-2025.docx
//   eval/psle-math-top5-10y.png (standalone chart preview)

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
  // Casing duplicate seen in the bank.
  if (/^basic math operations$/i.test(t)) return "Basic Math Operations";
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

function wrapTopicLabel(topic: string, maxCharsPerLine: number): string[] {
  if (topic.length <= maxCharsPerLine) return [topic];
  const words = topic.split(" ");
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

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

async function buildTop5Chart(rows: { topic: string; perYear: number }[]): Promise<Buffer> {
  const N = rows.length;
  const rowH = 120;
  const labelW = 340;
  const padLeft = 16;
  const padRight = 90;
  const padTop = 90;
  const padBottom = 60;
  const chartW = 380;
  const W = padLeft + labelW + chartW + padRight;
  const H = padTop + N * rowH + padBottom;

  const maxVal = Math.max(...rows.map(r => r.perYear), 1);
  const axisMax = Math.ceil(maxVal / 2) * 2;
  const x0 = padLeft + labelW;
  function valToX(v: number): number { return x0 + (v / axisMax) * chartW; }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Inter, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);
  parts.push(`<text x="${W / 2}" y="44" text-anchor="middle" font-size="26" font-weight="bold" fill="#001E40">Top 5 PSLE Math topics — Avg marks per year (2016-2025)</text>`);

  const barH = rowH - 30;
  rows.forEach((r, i) => {
    const baseY = padTop + i * rowH;
    const yMid = baseY + rowH / 2;
    const barY = baseY + 15;
    const w = Math.max(0, valToX(r.perYear) - x0);
    const wholeVal = Math.round(r.perYear);
    const lines = wrapTopicLabel(r.topic, 26);

    parts.push(`<circle cx="${padLeft + 22}" cy="${yMid}" r="20" fill="#006C49"/>`);
    parts.push(`<text x="${padLeft + 22}" y="${yMid + 7}" text-anchor="middle" font-size="20" font-weight="bold" fill="white">${i + 1}</text>`);

    if (lines.length === 1) {
      parts.push(`<text x="${padLeft + 54}" y="${yMid + 7}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[0])}</text>`);
    } else {
      parts.push(`<text x="${padLeft + 54}" y="${yMid - 4}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[0])}</text>`);
      parts.push(`<text x="${padLeft + 54}" y="${yMid + 20}" font-size="19" fill="#001E40" font-weight="bold">${escapeXml(lines[1])}</text>`);
    }

    parts.push(`<rect x="${x0}" y="${barY}" width="${w}" height="${barH}" fill="#006C49" rx="3"/>`);
    parts.push(`<text x="${x0 + w + 10}" y="${yMid + 9}" font-size="24" font-weight="bold" fill="#001E40">${wholeVal}</text>`);
  });

  parts.push(`<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-size="18" font-weight="bold" fill="#006C49">www.MarkForYou.com</text>`);
  parts.push("</svg>");
  return sharp(Buffer.from(parts.join(""))).png().toBuffer();
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

const YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

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
  const math = papers.filter(p => (p.subject ?? "").toLowerCase().includes("math"));

  // Per-year bags + combined 10-year bag.
  const perYear = new Map<number, Map<string, Cell>>();
  const combined = new Map<string, Cell>();
  let totalMarks = 0;
  let paperEquiv = 0;
  const inventory: { year: number; title: string; qCount: number; marks: number }[] = [];

  for (const y of YEARS) perYear.set(y, new Map());

  for (const p of math) {
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    if (y < 2016 || y > 2025) continue;
    const m = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    inventory.push({ year: y, title: p.title ?? "", qCount: p.questions.length, marks: m });
    totalMarks += m;
    paperEquiv += m / 100;
    const bag = bagPaper(p);
    for (const [t, c] of bag) {
      combined.set(t, add(combined.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
      perYear.get(y)!.set(t, add(perYear.get(y)!.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
    }
  }
  inventory.sort((a, b) => a.year - b.year);

  // 10-year ranking.
  type Rank = { topic: string; total: number; perYear: number; mcq: number; oeq: number; oeqShare: number; share: number };
  const ranks: Rank[] = [...combined.entries()].map(([topic, c]) => {
    const total = cellMarks(c);
    return {
      topic, total,
      perYear: paperEquiv > 0 ? total / paperEquiv : 0,
      mcq: c.mcqM, oeq: c.oeqM,
      oeqShare: total > 0 ? (c.oeqM / total) * 100 : 0,
      share: totalMarks > 0 ? (total / totalMarks) * 100 : 0,
    };
  }).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
  const top5 = ranks.slice(0, 5);

  // Chart.
  const chartBytes = await buildTop5Chart(top5.map(r => ({ topic: r.topic, perYear: r.perYear })));
  await fs.writeFile(path.join("eval", "psle-math-top5-10y.png"), chartBytes);
  const chartMeta = await sharp(chartBytes).metadata();
  const chartParaImg = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png", data: chartBytes,
      transformation: { width: 5.0 * 96, height: 5.0 * 96 * ((chartMeta.height ?? 1) / (chartMeta.width ?? 1)) },
    })],
  });

  // Tables.
  const invTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({ children: [
        cellEl("Year", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("Paper", { bold: true, bg: "EAF3FB" }),
        cellEl("Questions", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("Marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      ] }),
      ...inventory.map(it => new TableRow({ children: [
        cellEl(String(it.year), { align: AlignmentType.CENTER }),
        cellEl(it.title),
        cellEl(String(it.qCount), { align: AlignmentType.CENTER }),
        cellEl(String(it.marks), { align: AlignmentType.CENTER }),
      ] })),
    ],
  });

  const rankTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({ children: [
        cellEl("Rank", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("Topic", { bold: true, bg: "EAF3FB" }),
        cellEl("Total marks", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("Marks / year", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("Share %", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("MCQ : OEQ", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
        cellEl("OEQ share", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER }),
      ] }),
      ...ranks.map((r, i) => new TableRow({ children: [
        cellEl(String(i + 1), { align: AlignmentType.CENTER, bold: i < 5, color: i < 5 ? GREEN : undefined }),
        cellEl(r.topic, { bold: i < 5 }),
        cellEl(String(r.total), { align: AlignmentType.CENTER }),
        cellEl(r.perYear.toFixed(1), { align: AlignmentType.CENTER }),
        cellEl(`${r.share.toFixed(1)}%`, { align: AlignmentType.CENTER }),
        cellEl(`${r.mcq}:${r.oeq}`, { align: AlignmentType.CENTER }),
        cellEl(`${r.oeqShare.toFixed(0)}%`, { align: AlignmentType.CENTER }),
      ] })),
    ],
  });

  // Year-by-year matrix.
  const sortedTopics = ranks.map(r => r.topic);
  const matrixHeader = new TableRow({ children: [
    cellEl("Topic", { bold: true, bg: "EAF3FB" }),
    ...YEARS.map(y => cellEl(String(y), { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER })),
    cellEl("Avg/yr", { bold: true, bg: "EAF3FB", align: AlignmentType.CENTER, color: NAVY }),
  ] });
  const matrixRows = sortedTopics.map(t => {
    const cells: TableCell[] = [cellEl(t)];
    let total = 0;
    for (const y of YEARS) {
      const c = perYear.get(y)?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
      const m = cellMarks(c);
      total += m;
      cells.push(cellEl(m === 0 ? "—" : String(m), { align: AlignmentType.CENTER, color: m === 0 ? "BBBBBB" : undefined }));
    }
    cells.push(cellEl((total / YEARS.length).toFixed(1), { align: AlignmentType.CENTER, bold: true, color: NAVY }));
    return new TableRow({ children: cells });
  });
  const matrixTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [matrixHeader, ...matrixRows],
  });

  // Document.
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
    title: "PSLE Math Topic Marks 2016-2025",
    sections: [{
      properties: {},
      children: [
        h("PSLE Math: Topic Marks 2016-2025", HeadingLevel.HEADING_1),
        p("A decade of PSLE Mathematics papers, broken down by syllabus topic. Unlike Science, the bank holds individual yearly papers for every year 2016-2025 (10 papers, 100 marks each), so the analysis below is a clean 10-paper sample with no aggregated buckets.", { italic: true, color: GREY }),
        blank(),

        h("Window totals", HeadingLevel.HEADING_2),
        bullet(`Papers: ${inventory.length}`),
        bullet(`Total marks: ${totalMarks}`),
        bullet(`Paper-equivalents: ${paperEquiv.toFixed(2)}`),
        bullet(`Average marks per paper across all topics: ${(totalMarks / paperEquiv).toFixed(1)}`),
        p("Topic merge: 'Basic Math Operations' and 'Basic math operations' (a casing duplicate in the bank) are summed into a single row.", { italic: true, color: GREY }),
        blank(),

        h("Top 5 topics — Avg marks per year", HeadingLevel.HEADING_2),
        p("Marks per paper-equivalent (i.e. the expected weight on a single PSLE Math paper) averaged across the decade."),
        blank(),
        chartParaImg,
        blank(),

        h("10-year ranking — every topic", HeadingLevel.HEADING_2),
        p("Top 5 highlighted in green. /year is marks per paper-equivalent; share % is the topic's slice of total marks; OEQ share is the percentage of the topic's marks that come from open-ended (non-MCQ) questions."),
        blank(),
        rankTable,
        blank(),
        p(`The top 5 together account for ${top5.reduce((s, r) => s + r.share, 0).toFixed(0)}% of total PSLE Math marks across the decade. Drilling these five well covers the bulk of the test weight.`, { bold: true }),
        blank(),

        h("Year-by-year variations", HeadingLevel.HEADING_2),
        p("Marks per topic per year. An em-dash (—) means zero marks on that topic that year. Avg/yr is the 10-year mean per topic."),
        blank(),
        matrixTable,
        blank(),

        h("Observations", HeadingLevel.HEADING_2),
        ...buildObservations(perYear, ranks).map(s => bullet(s)),
        blank(),

        h("Paper inventory", HeadingLevel.HEADING_2),
        invTable,
        blank(),

        h("Reproducibility", HeadingLevel.HEADING_2),
        p("Run:  npx tsx scripts/_psle-math-10y-docx.ts"),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join("eval", "PSLE-Math-Topic-Marks-2016-2025.docx");
  await fs.writeFile(outPath, buffer);
  console.log(`Wrote ${outPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`Wrote eval/psle-math-top5-10y.png standalone preview`);

  await prisma.$disconnect();
}

// Generate punchy observation bullets from the per-year data.
function buildObservations(perYear: Map<number, Map<string, Cell>>, ranks: { topic: string; perYear: number; share: number }[]): string[] {
  const out: string[] = [];
  const topicYearMarks = (t: string) => YEARS.map(y => cellMarks(perYear.get(y)?.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }));

  // For each top-5 topic, describe its trajectory.
  for (const r of ranks.slice(0, 5)) {
    const series = topicYearMarks(r.topic);
    const lo = Math.min(...series), hi = Math.max(...series);
    const yrLo = YEARS[series.indexOf(lo)], yrHi = YEARS[series.indexOf(hi)];
    const recent5 = series.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const early5 = series.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const dir = recent5 > early5 + 1 ? "trending up" : recent5 < early5 - 1 ? "trending down" : "stable";
    out.push(`${r.topic}: averages ${r.perYear.toFixed(1)} marks/year, ${dir} (early-5 avg ${early5.toFixed(1)} → recent-5 avg ${recent5.toFixed(1)}). Range ${lo}–${hi} marks (low in ${yrLo}, peak in ${yrHi}).`);
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
