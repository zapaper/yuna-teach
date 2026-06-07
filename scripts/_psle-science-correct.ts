// Corrected PSLE Science analysis. Key insight: the bank does NOT have
// individual 2022, 2023, 2024 PSLE Science papers. What it DOES have is
// 4 aggregated "PSLE Science 2022-2024" buckets:
//   - Life Science MCQ 2022-2024     (42 Qs, 84 marks)
//   - Life Science OEQ 2022-2024     (20 Qs, 63 marks)
//   - Physical Science MCQ 2022-2024 (42 Qs, 84 marks)
//   - Physical Science OEQ 2022-2024 (18 Qs, 66 marks)
//   Total: 297 marks ≈ 3 papers worth (since each real paper is 100m)
//
// All four are dated 2022 in the bank but represent 2022-2024 combined.
// They must be summed for any "recent PSLE" analysis — using just one
// bucket gives an MCQ-only or biology-only or physics-only view that
// flips the conclusions on the heavily-OEQ-weighted topics.
//
// This script:
//  1. Aggregates the 4 buckets as a single "2022-2024 combined" pool.
//  2. Normalises everything to marks-per-paper-year so windows of
//     different durations compare cleanly.
//  3. Splits by MCQ vs OEQ marks so we can see whether shifts are
//     driven by short-answer or open-ended question shape.

import { prisma } from "../src/lib/db";

function bucketSubject(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("science")) return "Science";
  return "Other";
}

async function main() {
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
  const sci = papers.filter(p => bucketSubject(p.subject) === "Science");

  function isMcq(q: { transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }): boolean {
    if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
    if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
    const t = q.transcribedOptionTable;
    if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
    return false;
  }

  type Cell = { mcqM: number; oeqM: number; qCount: number };
  function emptyCell(): Cell { return { mcqM: 0, oeqM: 0, qCount: 0 }; }
  function addCell(a: Cell, b: Cell): Cell { return { mcqM: a.mcqM + b.mcqM, oeqM: a.oeqM + b.oeqM, qCount: a.qCount + b.qCount }; }
  function cellMarks(c: Cell): number { return c.mcqM + c.oeqM; }

  function bagPaper(p: typeof sci[number]): Map<string, Cell> {
    const out = new Map<string, Cell>();
    for (const q of p.questions) {
      const topic = (q.syllabusTopic ?? "").trim() || "(Untagged)";
      const m = Number(q.marksAvailable);
      if (!Number.isFinite(m) || m <= 0) continue;
      const cur = out.get(topic) ?? emptyCell();
      if (isMcq(q)) cur.mcqM += m; else cur.oeqM += m;
      cur.qCount++;
      out.set(topic, cur);
    }
    return out;
  }

  // Identify the four 2022-2024 aggregated buckets vs individual-year papers.
  const isAggBucket = (p: typeof sci[number]) => /2022-2024/i.test(p.title ?? "");
  const aggBuckets = sci.filter(isAggBucket);
  console.log("2022-2024 aggregated buckets in bank:");
  for (const p of aggBuckets) {
    const totalM = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    console.log(`  ${p.id}  ${p.title}   Qs:${p.questions.length}  Marks:${totalM}`);
  }
  console.log();

  // Index by year (skip the aggregate buckets in the per-year map).
  const byYear = new Map<number, typeof sci>();
  for (const p of sci) {
    if (isAggBucket(p)) continue;
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    if (y === 0) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p);
  }

  // Combine windows — for each window, sum across all papers in window.
  // For "2022-2024 combined" we use the 4 aggregated buckets together.
  function aggregateYears(years: number[]): { bag: Map<string, Cell>; paperEquiv: number; totalM: number } {
    const bag = new Map<string, Cell>();
    let totalM = 0;
    let paperEquiv = 0;
    for (const y of years) {
      const ps = byYear.get(y) ?? [];
      for (const p of ps) {
        const b = bagPaper(p);
        for (const [t, c] of b) bag.set(t, addCell(bag.get(t) ?? emptyCell(), c));
        const m = [...b.values()].reduce((s, c) => s + cellMarks(c), 0);
        totalM += m;
        // Each real paper ≈ 100 marks; use that as a normalisation unit.
        paperEquiv += m / 100;
      }
    }
    return { bag, paperEquiv, totalM };
  }

  function aggregate2022to2024(): { bag: Map<string, Cell>; paperEquiv: number; totalM: number } {
    const bag = new Map<string, Cell>();
    let totalM = 0;
    for (const p of aggBuckets) {
      const b = bagPaper(p);
      for (const [t, c] of b) bag.set(t, addCell(bag.get(t) ?? emptyCell(), c));
      const m = [...b.values()].reduce((s, c) => s + cellMarks(c), 0);
      totalM += m;
    }
    // 297 total marks ≈ 3 papers (PSLE Science is 100 marks per paper).
    const paperEquiv = totalM / 100;
    return { bag, paperEquiv, totalM };
  }

  function compare(labelE: string, eAgg: ReturnType<typeof aggregateYears>, labelL: string, lAgg: ReturnType<typeof aggregateYears>) {
    console.log("\n" + "=".repeat(125));
    console.log(`${labelE}  vs  ${labelL}`);
    console.log(`  ${labelE}: ${eAgg.paperEquiv.toFixed(1)} paper-equiv, ${eAgg.totalM} marks total`);
    console.log(`  ${labelL}: ${lAgg.paperEquiv.toFixed(1)} paper-equiv, ${lAgg.totalM} marks total`);
    console.log("=".repeat(125));

    const all = new Set([...eAgg.bag.keys(), ...lAgg.bag.keys()]);
    type Row = { topic: string; eM: number; lM: number; eMcq: number; eOeq: number; lMcq: number; lOeq: number; ePerP: number; lPerP: number; dPerP: number; dPpt: number };
    const rows: Row[] = [];
    for (const t of all) {
      const e = eAgg.bag.get(t) ?? emptyCell();
      const l = lAgg.bag.get(t) ?? emptyCell();
      const eM = cellMarks(e);
      const lM = cellMarks(l);
      const ePerP = eAgg.paperEquiv > 0 ? eM / eAgg.paperEquiv : 0;
      const lPerP = lAgg.paperEquiv > 0 ? lM / lAgg.paperEquiv : 0;
      const ePpt = eAgg.totalM > 0 ? (eM / eAgg.totalM) * 100 : 0;
      const lPpt = lAgg.totalM > 0 ? (lM / lAgg.totalM) * 100 : 0;
      rows.push({ topic: t, eM, lM, eMcq: e.mcqM, eOeq: e.oeqM, lMcq: l.mcqM, lOeq: l.oeqM, ePerP, lPerP, dPerP: lPerP - ePerP, dPpt: lPpt - ePpt });
    }
    rows.sort((a, b) => (b.eM + b.lM) - (a.eM + a.lM));

    console.log("Topic".padEnd(46), "  Early M  /paper   MCQ:OEQ".padEnd(28), "  Late M  /paper   MCQ:OEQ".padEnd(28), "  Δm/paper");
    console.log("-".repeat(125));
    for (const r of rows) {
      const eStr = `${String(r.eM).padStart(5)} ${r.ePerP.toFixed(1).padStart(5)}p ${r.eMcq}:${r.eOeq}`.padEnd(28);
      const lStr = `${String(r.lM).padStart(5)} ${r.lPerP.toFixed(1).padStart(5)}p ${r.lMcq}:${r.lOeq}`.padEnd(28);
      const arrow = r.dPerP > 1 ? "↑↑" : r.dPerP > 0.5 ? "↑" : r.dPerP < -1 ? "↓↓" : r.dPerP < -0.5 ? "↓" : "·";
      console.log(
        r.topic.slice(0, 44).padEnd(46),
        eStr,
        lStr,
        `${r.dPerP >= 0 ? "+" : ""}${r.dPerP.toFixed(1)} m/p`.padStart(10),
        arrow,
      );
    }
  }

  const w1821 = aggregateYears([2018, 2019, 2020, 2021]);
  const w2022_2024 = aggregate2022to2024();
  const w2025 = aggregateYears([2025]);
  const wRecent = (() => {
    const bag = new Map<string, Cell>();
    let totalM = 0;
    let paperEquiv = 0;
    for (const src of [w2022_2024, w2025]) {
      for (const [t, c] of src.bag) bag.set(t, addCell(bag.get(t) ?? emptyCell(), c));
      totalM += src.totalM;
      paperEquiv += src.paperEquiv;
    }
    return { bag, paperEquiv, totalM };
  })();

  compare("2018-2021 (4 papers)", w1821,
          "2022-2024 (3 papers combined from buckets)", w2022_2024);
  compare("2018-2021 (4 papers)", w1821,
          "2022-2025 (3 buckets + 2025 = ~4 papers)", wRecent);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
