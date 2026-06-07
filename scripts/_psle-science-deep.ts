// Deep PSLE Science analysis — per-year, per-topic marks + question
// counts + MCQ/OEQ split. Also dumps the paper inventory so we can
// see whether duplicate entries are skewing windowed totals.

import { prisma } from "../src/lib/db";

const ALL_YEARS = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

function bucketSubject(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("math")) return "Math";
  if (s.includes("science")) return "Science";
  if (s.includes("english")) return "English";
  if (s.includes("chinese") || s.includes("华文")) return "Chinese";
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
      id: true, title: true, subject: true, year: true, examType: true, visible: true,
      questions: {
        select: {
          id: true, questionNum: true, syllabusTopic: true, marksAvailable: true,
          transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
        },
      },
    },
  });
  const sciencePapers = papers.filter(p => bucketSubject(p.subject) === "Science");

  console.log("PSLE SCIENCE PAPER INVENTORY");
  console.log("=".repeat(95));
  console.log("year  visible  paperId                              title");
  console.log("-".repeat(95));
  const byYear = new Map<number, typeof sciencePapers>();
  for (const p of sciencePapers) {
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p);
  }
  for (const y of [...byYear.keys()].sort()) {
    for (const p of byYear.get(y)!) {
      const totalQs = p.questions.length;
      const totalMarks = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
      console.log(
        String(y).padStart(4),
        String(p.visible).padEnd(7),
        p.id.padEnd(28),
        (p.title ?? "").slice(0, 45).padEnd(46),
        `Qs:${totalQs} Marks:${totalMarks}`,
      );
    }
  }
  console.log();

  // Per-year topic marks + question count, MCQ vs OEQ split.
  type Cell = { qCount: number; marks: number; mcqM: number; oeqM: number };
  function isMcq(q: { transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown }): boolean {
    const opts = q.transcribedOptions;
    const imgs = q.transcribedOptionImages;
    const tbl = q.transcribedOptionTable;
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
    if (tbl && typeof tbl === "object" && Array.isArray((tbl as { rows?: unknown }).rows) && (tbl as { rows: unknown[] }).rows.length === 4) return true;
    return false;
  }

  // De-dupe: pick one paper per year. Strategy: prefer visible=true; if
  // there are multiple visible, pick the one whose question count is
  // closest to 32 (PSLE Science standard). Log who we picked vs dropped.
  console.log("DEDUPED PAPER PICKS (one per year):");
  console.log("-".repeat(60));
  const pickedByYear = new Map<number, typeof sciencePapers[number]>();
  for (const [y, ps] of byYear) {
    if (ps.length === 1) {
      pickedByYear.set(y, ps[0]);
      continue;
    }
    // Multiple — score each
    const ranked = [...ps].sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1; // visible first
      const aD = Math.abs(a.questions.length - 32);
      const bD = Math.abs(b.questions.length - 32);
      return aD - bD;
    });
    pickedByYear.set(y, ranked[0]);
    for (const dropped of ranked.slice(1)) {
      console.log(`  ${y}: DROPPED ${dropped.id} (visible=${dropped.visible}, Qs=${dropped.questions.length}, title="${dropped.title?.slice(0,40)}")`);
    }
    console.log(`  ${y}:  KEPT  ${ranked[0].id} (visible=${ranked[0].visible}, Qs=${ranked[0].questions.length}, title="${ranked[0].title?.slice(0,40)}")`);
  }
  console.log();

  // Per-year topic tally
  type YearTopic = Map<string, Cell>;
  const perYear = new Map<number, YearTopic>();
  for (const [y, p] of pickedByYear) {
    const bag: YearTopic = new Map();
    for (const q of p.questions) {
      const topic = (q.syllabusTopic ?? "").trim() || "(Untagged)";
      const m = Number(q.marksAvailable);
      if (!Number.isFinite(m) || m <= 0) continue;
      const cell = bag.get(topic) ?? { qCount: 0, marks: 0, mcqM: 0, oeqM: 0 };
      cell.qCount++;
      cell.marks += m;
      if (isMcq(q)) cell.mcqM += m;
      else cell.oeqM += m;
      bag.set(topic, cell);
    }
    perYear.set(y, bag);
  }

  // List every topic ever seen (after dedupe).
  const topicSet = new Set<string>();
  for (const yb of perYear.values()) for (const t of yb.keys()) topicSet.add(t);
  const topics = [...topicSet].sort();

  // Per-year marks table.
  const yearsSeen = [...perYear.keys()].sort();
  console.log("MARKS PER TOPIC PER YEAR (deduped)");
  console.log("=".repeat(120));
  const header = "Topic".padEnd(46) + yearsSeen.map(y => String(y).padStart(6)).join("") + "  Total";
  console.log(header);
  console.log("-".repeat(120));
  const totalsPerTopic: { t: string; total: number; row: string }[] = [];
  for (const t of topics) {
    let total = 0;
    const cells = yearsSeen.map(y => {
      const c = perYear.get(y)?.get(t);
      const m = c?.marks ?? 0;
      total += m;
      return String(m).padStart(6);
    });
    totalsPerTopic.push({ t, total, row: t.slice(0, 44).padEnd(46) + cells.join("") + "  " + String(total).padStart(5) });
  }
  totalsPerTopic.sort((a, b) => b.total - a.total);
  for (const r of totalsPerTopic) console.log(r.row);
  console.log();

  // Window comparisons — try BOTH ways the user might have framed it.
  const WINDOWS: { label: string; years: number[] }[] = [
    { label: "2018-2021", years: [2018, 2019, 2020, 2021] },
    { label: "2020-2021", years: [2020, 2021] },
    { label: "2022-2024", years: [2022, 2023, 2024] },
    { label: "2022-2025", years: [2022, 2023, 2024, 2025] },
  ];

  function aggregate(win: number[]): Map<string, Cell> {
    const out = new Map<string, Cell>();
    for (const y of win) {
      const yb = perYear.get(y);
      if (!yb) continue;
      for (const [t, c] of yb) {
        const cur = out.get(t) ?? { qCount: 0, marks: 0, mcqM: 0, oeqM: 0 };
        cur.qCount += c.qCount;
        cur.marks += c.marks;
        cur.mcqM += c.mcqM;
        cur.oeqM += c.oeqM;
        out.set(t, cur);
      }
    }
    return out;
  }

  // Two comparison frames.
  function compare(labelEarly: string, early: Map<string, Cell>, labelLate: string, late: Map<string, Cell>) {
    const earlyTotal = [...early.values()].reduce((s, c) => s + c.marks, 0);
    const lateTotal = [...late.values()].reduce((s, c) => s + c.marks, 0);
    const earlyPapers = WINDOWS.find(w => w.label === labelEarly)!.years.filter(y => perYear.has(y)).length;
    const latePapers = WINDOWS.find(w => w.label === labelLate)!.years.filter(y => perYear.has(y)).length;
    console.log(`\n${labelEarly} (${earlyPapers}p, ${earlyTotal}m)  vs  ${labelLate} (${latePapers}p, ${lateTotal}m)`);
    console.log("=".repeat(120));
    console.log("Topic".padEnd(46), `${labelEarly}M  /paper  ${labelEarly}%`.padStart(22), `${labelLate}M  /paper  ${labelLate}%`.padStart(22), "  Δppt    Δm/p");
    console.log("-".repeat(120));
    const all = new Set([...early.keys(), ...late.keys()]);
    const rows = [...all].map(t => {
      const e = early.get(t) ?? { qCount: 0, marks: 0, mcqM: 0, oeqM: 0 };
      const l = late.get(t) ?? { qCount: 0, marks: 0, mcqM: 0, oeqM: 0 };
      const eP = earlyTotal > 0 ? (e.marks / earlyTotal) * 100 : 0;
      const lP = lateTotal > 0 ? (l.marks / lateTotal) * 100 : 0;
      const ePerP = earlyPapers > 0 ? e.marks / earlyPapers : 0;
      const lPerP = latePapers > 0 ? l.marks / latePapers : 0;
      return { t, eM: e.marks, lM: l.marks, eP, lP, ePerP, lPerP, dPpt: lP - eP, dPerP: lPerP - ePerP };
    }).sort((a, b) => (b.eM + b.lM) - (a.eM + a.lM));
    for (const r of rows) {
      const eStr = `${r.eM}  ${r.ePerP.toFixed(1)}p  ${r.eP.toFixed(1)}%`.padStart(22);
      const lStr = `${r.lM}  ${r.lPerP.toFixed(1)}p  ${r.lP.toFixed(1)}%`.padStart(22);
      const arrow = r.dPerP > 0.5 ? "↑" : r.dPerP < -0.5 ? "↓" : " ";
      console.log(
        r.t.slice(0, 44).padEnd(46),
        eStr,
        lStr,
        `${r.dPpt >= 0 ? "+" : ""}${r.dPpt.toFixed(1)}pt`.padStart(8),
        `${r.dPerP >= 0 ? "+" : ""}${r.dPerP.toFixed(1)}m`.padStart(7),
        arrow,
      );
    }
  }

  compare("2018-2021", aggregate([2018, 2019, 2020, 2021]),
          "2022-2025", aggregate([2022, 2023, 2024, 2025]));
  compare("2020-2021", aggregate([2020, 2021]),
          "2022-2024", aggregate([2022, 2023, 2024]));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
