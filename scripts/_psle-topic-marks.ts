// PSLE topic frequency analysis — by total marks per topic — split
// across 2018-2021 vs 2022-2025 to surface what's been gaining or
// losing weight on recent papers.
//
// Counts only master PSLE papers (sourceExamId=null, paperType=null).
// Per-question marks come from `marksAvailable`; rows without marks
// or without a syllabusTopic are excluded.

import { prisma } from "../src/lib/db";

const PERIODS = [
  { label: "2018-2021", years: [2018, 2019, 2020, 2021] },
  { label: "2022-2025", years: [2022, 2023, 2024, 2025] },
] as const;

type Bucket = { topic: string; marks: number; papers: Set<string> };
type SubjectAgg = Record<string, Record<string, Bucket>>;

function bucketSubject(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("math")) return "Math";
  if (s.includes("science")) return "Science";
  if (s.includes("english")) return "English";
  if (s.includes("chinese") || s.includes("华文")) return "Chinese";
  return "Other";
}

async function main() {
  // Pull every PSLE master paper with its questions' topic + marks.
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
      questions: { select: { syllabusTopic: true, marksAvailable: true } },
    },
  });
  console.log(`Loaded ${papers.length} PSLE master papers.\n`);

  // Per subject → per period → per topic
  const agg: Record<string, SubjectAgg> = {};
  const paperYearMap = new Map<string, number>();
  for (const p of papers) {
    const y = parseInt((p.year ?? "").match(/\d{4}/)?.[0] ?? "0", 10);
    paperYearMap.set(p.id, y);
  }

  // Audit: how many PSLE papers per (subject, year)?
  const auditCounts = new Map<string, number>();
  for (const p of papers) {
    const subj = bucketSubject(p.subject);
    const y = paperYearMap.get(p.id) ?? 0;
    const k = `${subj}|${y}`;
    auditCounts.set(k, (auditCounts.get(k) ?? 0) + 1);
  }
  console.log("PSLE paper inventory (subject × year):");
  const subjects = [...new Set([...auditCounts.keys()].map(k => k.split("|")[0]))].sort();
  const years = [...new Set([...auditCounts.keys()].map(k => Number(k.split("|")[1])))].filter(y => y > 0).sort();
  console.log("  " + "subject".padEnd(10) + years.map(y => String(y).padStart(5)).join(""));
  for (const subj of subjects) {
    const row = years.map(y => String(auditCounts.get(`${subj}|${y}`) ?? 0).padStart(5)).join("");
    console.log("  " + subj.padEnd(10) + row);
  }
  console.log();

  // Tally marks by subject × period × topic.
  for (const p of papers) {
    const subj = bucketSubject(p.subject);
    if (subj === "Other") continue;
    const y = paperYearMap.get(p.id) ?? 0;
    let period: string | null = null;
    for (const pd of PERIODS) if (pd.years.includes(y)) period = pd.label;
    if (!period) continue;

    agg[subj] ??= {};
    agg[subj][period] ??= {};
    const bag = agg[subj][period];

    for (const q of p.questions) {
      const topic = (q.syllabusTopic ?? "").trim() || "(Untagged)";
      const m = Number(q.marksAvailable ?? 0);
      if (!Number.isFinite(m) || m <= 0) continue;
      bag[topic] ??= { topic, marks: 0, papers: new Set() };
      bag[topic].marks += m;
      bag[topic].papers.add(p.id);
    }
  }

  // Print per-subject side-by-side comparison.
  for (const subj of Object.keys(agg).sort()) {
    const earlyBag = agg[subj]["2018-2021"] ?? {};
    const lateBag = agg[subj]["2022-2025"] ?? {};
    const earlyPapers = new Set(Object.values(earlyBag).flatMap(b => [...b.papers]));
    const latePapers = new Set(Object.values(lateBag).flatMap(b => [...b.papers]));
    const earlyTotal = Object.values(earlyBag).reduce((s, b) => s + b.marks, 0);
    const lateTotal = Object.values(lateBag).reduce((s, b) => s + b.marks, 0);

    console.log("=".repeat(95));
    console.log(`${subj} PSLE — topic marks by period`);
    console.log(`  2018-2021: ${earlyPapers.size} papers, ${earlyTotal} total marks tagged`);
    console.log(`  2022-2025: ${latePapers.size} papers, ${lateTotal} total marks tagged`);
    console.log("=".repeat(95));

    const allTopics = new Set([...Object.keys(earlyBag), ...Object.keys(lateBag)]);
    const rows = [...allTopics].map(t => {
      const eM = earlyBag[t]?.marks ?? 0;
      const lM = lateBag[t]?.marks ?? 0;
      const ePct = earlyTotal > 0 ? (eM / earlyTotal) * 100 : 0;
      const lPct = lateTotal > 0 ? (lM / lateTotal) * 100 : 0;
      const dPct = lPct - ePct;
      return { topic: t, eM, lM, ePct, lPct, dPct };
    }).sort((a, b) => (b.eM + b.lM) - (a.eM + a.lM));

    console.log("Topic".padEnd(48), " 18-21M  18-21%   22-25M  22-25%    Δ% pts");
    console.log("-".repeat(95));
    for (const r of rows) {
      const arrow = r.dPct > 1 ? "↑" : r.dPct < -1 ? "↓" : "•";
      console.log(
        r.topic.slice(0, 46).padEnd(48),
        String(r.eM).padStart(6),
        `${r.ePct.toFixed(1)}%`.padStart(7),
        String(r.lM).padStart(8),
        `${r.lPct.toFixed(1)}%`.padStart(7),
        `${r.dPct >= 0 ? "+" : ""}${r.dPct.toFixed(1)} ${arrow}`.padStart(10),
      );
    }
    console.log();
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
