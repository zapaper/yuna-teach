// PSLE Science 5-year analysis: 2021-2025 vs 2016-2020 baseline.
//
// Bank inventory:
//   2016, 2017, 2018, 2019, 2020, 2021, 2025: full 100-mark papers (1 per year)
//   2022-2024: 4 aggregated buckets (Life MCQ + Life OEQ + Physical MCQ
//     + Physical OEQ), each holding 3 years' worth of questions for that
//     question shape × strand. Total 297 marks ≈ 3 paper-equivalents.
//
// 5-year windows:
//   2016-2020: 5 actual papers, 500 marks
//   2021-2025: 2021 (100m) + 4 buckets (297m) + 2025 (100m) = 497m ≈ 5 papers
//
// The buckets are the only data we have for 2022-2024. We treat them
// as a single 3-paper-equivalent sample and sum them.

import { prisma } from "../src/lib/db";

type Cell = { mcqM: number; oeqM: number; qCount: number };

function isMcq(q: { transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
  const t = q.transcribedOptionTable;
  if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

// Merge MOE-syllabus families that the bank stores as separate tags.
// "Interaction of forces (Friction/Gravity)" and "(Magnets)" are both
// sub-strands of the single MOE "Interaction of Forces" topic, so they
// roll up into one row before the comparison tables.
function normaliseTopic(raw: string): string {
  const t = raw.trim();
  if (/^Interaction of forces/i.test(t)) return "Interaction of forces (Friction / Gravity / Magnets)";
  return t;
}

function bagPaper(p: { questions: Array<{ syllabusTopic: string | null; marksAvailable: number | null; transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }> }): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const q of p.questions) {
    const rawTopic = (q.syllabusTopic ?? "").trim() || "(Untagged)";
    const topic = normaliseTopic(rawTopic);
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
function addCell(a: Cell, b: Cell): Cell { return { mcqM: a.mcqM + b.mcqM, oeqM: a.oeqM + b.oeqM, qCount: a.qCount + b.qCount }; }

export type WindowAgg = { bag: Map<string, Cell>; paperEquiv: number; totalM: number; paperList: string[] };

export async function loadAndAggregate(): Promise<{
  inventory: { year: number | string; title: string; totalMarks: number; qCount: number }[];
  win2016_2020: WindowAgg;
  win2021_2025: WindowAgg;
}> {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      OR: [
        { level: { equals: "PSLE", mode: "insensitive" } },
        { title: { contains: "PSLE", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, title: true, subject: true, year: true,
      questions: {
        select: {
          syllabusTopic: true, marksAvailable: true,
          transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
        },
      },
    },
  });
  const sci = papers.filter(p => (p.subject ?? "").toLowerCase().includes("science"));

  const isAgg = (p: typeof sci[number]) => /2022-2024/i.test(p.title ?? "");
  const aggBuckets = sci.filter(isAgg);
  const yearPapers = sci.filter(p => !isAgg(p));

  const inventory: { year: number | string; title: string; totalMarks: number; qCount: number }[] = [];
  for (const p of yearPapers) {
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    const totalMarks = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    inventory.push({ year: y, title: p.title ?? "", totalMarks, qCount: p.questions.length });
  }
  for (const p of aggBuckets) {
    const totalMarks = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    inventory.push({ year: "2022-2024", title: p.title ?? "", totalMarks, qCount: p.questions.length });
  }
  inventory.sort((a, b) => String(a.year).localeCompare(String(b.year)));

  // Build windows.
  function aggregateYearRange(yMin: number, yMax: number): WindowAgg {
    const bag = new Map<string, Cell>();
    let totalM = 0;
    let paperEquiv = 0;
    const paperList: string[] = [];
    for (const p of yearPapers) {
      const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
      if (y < yMin || y > yMax) continue;
      const b = bagPaper(p);
      for (const [t, c] of b) bag.set(t, addCell(bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
      const m = [...b.values()].reduce((s, c) => s + cellMarks(c), 0);
      totalM += m;
      paperEquiv += m / 100;
      paperList.push(`${y}: ${p.title}`);
    }
    return { bag, paperEquiv, totalM, paperList };
  }

  const win2016_2020 = aggregateYearRange(2016, 2020);
  // 2021-2025 is 2021 + the 4 buckets + 2025.
  const win2021_2025 = (() => {
    const bag = new Map<string, Cell>();
    let totalM = 0;
    let paperEquiv = 0;
    const paperList: string[] = [];
    for (const p of yearPapers) {
      const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
      if (y !== 2021 && y !== 2025) continue;
      const b = bagPaper(p);
      for (const [t, c] of b) bag.set(t, addCell(bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
      const m = [...b.values()].reduce((s, c) => s + cellMarks(c), 0);
      totalM += m;
      paperEquiv += m / 100;
      paperList.push(`${y}: ${p.title}`);
    }
    for (const p of aggBuckets) {
      const b = bagPaper(p);
      for (const [t, c] of b) bag.set(t, addCell(bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 }, c));
      const m = [...b.values()].reduce((s, c) => s + cellMarks(c), 0);
      totalM += m;
      paperEquiv += m / 100;
      paperList.push(`2022-2024: ${p.title}`);
    }
    return { bag, paperEquiv, totalM, paperList };
  })();

  return { inventory, win2016_2020, win2021_2025 };
}

async function main() {
  const { inventory, win2016_2020, win2021_2025 } = await loadAndAggregate();

  console.log("INVENTORY");
  for (const it of inventory) {
    console.log(`  ${String(it.year).padEnd(11)} Qs:${String(it.qCount).padStart(3)}  Marks:${String(it.totalMarks).padStart(4)}  ${it.title}`);
  }
  console.log();

  console.log("2016-2020 window summary:");
  console.log(`  Papers: ${win2016_2020.paperList.length}`);
  console.log(`  Paper-equiv: ${win2016_2020.paperEquiv.toFixed(2)}`);
  console.log(`  Total marks: ${win2016_2020.totalM}`);
  console.log();

  console.log("2021-2025 window summary:");
  console.log(`  Inputs: ${win2021_2025.paperList.length}`);
  console.log(`  Paper-equiv: ${win2021_2025.paperEquiv.toFixed(2)}`);
  console.log(`  Total marks: ${win2021_2025.totalM}`);
  console.log();

  const allTopics = new Set([...win2016_2020.bag.keys(), ...win2021_2025.bag.keys()]);
  type Row = { topic: string; eM: number; lM: number; eMcq: number; eOeq: number; lMcq: number; lOeq: number; ePerP: number; lPerP: number; dPerP: number };
  const rows: Row[] = [];
  for (const t of allTopics) {
    const e = win2016_2020.bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
    const l = win2021_2025.bag.get(t) ?? { mcqM: 0, oeqM: 0, qCount: 0 };
    const eM = cellMarks(e);
    const lM = cellMarks(l);
    const ePerP = win2016_2020.paperEquiv > 0 ? eM / win2016_2020.paperEquiv : 0;
    const lPerP = win2021_2025.paperEquiv > 0 ? lM / win2021_2025.paperEquiv : 0;
    rows.push({ topic: t, eM, lM, eMcq: e.mcqM, eOeq: e.oeqM, lMcq: l.mcqM, lOeq: l.oeqM, ePerP, lPerP, dPerP: lPerP - ePerP });
  }
  rows.sort((a, b) => (b.eM + b.lM) - (a.eM + a.lM));

  console.log("Topic".padEnd(46), "2016-20 M  /p  MCQ:OEQ".padEnd(28), "2021-25 M  /p  MCQ:OEQ".padEnd(28), " Δm/p");
  console.log("-".repeat(125));
  for (const r of rows) {
    console.log(
      r.topic.slice(0, 44).padEnd(46),
      `${String(r.eM).padStart(5)} ${r.ePerP.toFixed(1).padStart(5)}p ${r.eMcq}:${r.eOeq}`.padEnd(28),
      `${String(r.lM).padStart(5)} ${r.lPerP.toFixed(1).padStart(5)}p ${r.lMcq}:${r.lOeq}`.padEnd(28),
      `${r.dPerP >= 0 ? "+" : ""}${r.dPerP.toFixed(1)} m/p`.padStart(10),
    );
  }

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
