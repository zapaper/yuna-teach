// MCQ supply per (level, subject, WA target period), applying:
//   1. Cumulative period pooling (WA2 = WA1+WA2, WA3 = WA1+WA2+WA3,
//      EOY = whole year + prior-year EOY).
//   2. PSLE-exclusion for P6 WA1/WA2 pools; PSLE lumped for P6 WA3/EOY.
//   3. Master paper only (paperType null, sourceExamId null,
//      extractionStatus ready) + sourceQuestionId null on the question.
//
// Reports how many MCQ are in the effective pool + top-5 topic counts
// for the diagnostic supply target (3 per topic × 5 topics = 15).

import "dotenv/config";
import { prisma } from "../src/lib/db";

type WA = "WA1" | "WA2" | "WA3" | "EOY";
type Level = "P4" | "P5" | "P6";

const POOL: Record<WA, WA[]> = {
  WA1: ["WA1"],
  WA2: ["WA1", "WA2"],
  WA3: ["WA1", "WA2", "WA3"],
  EOY: ["WA1", "WA2", "WA3", "EOY"],
};

function normLevel(l: string | null): Level | "P3" | "PSLE" | "(none)" {
  if (l === "PSLE") return "PSLE";
  if (l === "Primary 6" || l === "P6") return "P6";
  if (l === "Primary 5" || l === "P5") return "P5";
  if (l === "Primary 4" || l === "P4") return "P4";
  if (l === "Primary 3" || l === "P3") return "P3";
  return "(none)";
}
function subj(s: string | null): string {
  const l = (s ?? "").toLowerCase();
  if (l.includes("english")) return "English";
  if (l.includes("math")) return "Math";
  if (l.includes("science")) return "Science";
  if (l.includes("chinese")) return "Chinese";
  return "Other";
}
function waOf(title: string): WA | "(unlabelled)" {
  const t = title.toUpperCase();
  if (t.includes("WA1")) return "WA1";
  if (t.includes("WA2") || t.includes("MID YEAR") || t.includes("SA1")) return "WA2";
  if (t.includes("WA3")) return "WA3";
  if (t.includes("EOY") || t.includes("SA2") || t.includes("END OF YEAR") || t.includes("YEAR END")) return "EOY";
  return "(unlabelled)";
}

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      examPaper: { paperType: null, sourceExamId: null, extractionStatus: "ready" },
      syllabusTopic: { not: null },
    },
    select: {
      syllabusTopic: true, subTopic: true, transcribedOptions: true,
      examPaper: { select: { level: true, subject: true, title: true } },
    },
  });
  // Effective topic: for Basic-ops rows with a fine-grained subTopic
  // (populated by the 2026-07-01 classifier), the subTopic IS the
  // topic the diagnostic pulls from. Everything else uses syllabusTopic.
  const effectiveTopic = (r: (typeof rows)[number]): string => {
    const st = r.syllabusTopic ?? "?";
    if (st !== "Basic math operations" && st !== "Basic Math Operations") return st;
    return r.subTopic ?? st;
  };
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2);

  // Bucket: [rawLevel][subject][wa] -> Map(topic -> count)
  type Bag = Map<string, number>;
  const buckets = new Map<string, Bag>();
  for (const r of mcq) {
    const rawLevel = normLevel(r.examPaper.level);
    const subject = subj(r.examPaper.subject);
    // PSLE papers are always EOY-equivalent regardless of title (per
    // [[psle-lumped-with-p6]]). Everything else parses the WA from title.
    const wa = rawLevel === "PSLE" ? "EOY" : waOf(r.examPaper.title ?? "");
    if (rawLevel === "(none)" || subject === "Other" || wa === "(unlabelled)") continue;
    const key = `${rawLevel}|${subject}|${wa}`;
    const bag = buckets.get(key) ?? new Map<string, number>();
    const topic = effectiveTopic(r);
    bag.set(topic, (bag.get(topic) ?? 0) + 1);
    buckets.set(key, bag);
  }

  // Compose the effective pool for (targetLevel, subject, targetWA).
  // Per [[diagnostic-cumulative-period-pool]]:
  //   - Same-grade cumulative pooling
  //   - WA1 additionally pulls prior-grade EOY (kids arrive knowing
  //     last year's syllabus; SG WA1 papers are thin)
  //   - P6 WA3/EOY additionally fold in PSLE (per [[psle-lumped-with-p6]])
  //   - P6 WA1/WA2 exclude PSLE
  const PRIOR_GRADE: Record<Level, Level | "P3" | null> = { P4: "P3", P5: "P4", P6: "P5" };
  function effectivePool(target: Level, subject: string, targetWA: WA): Map<string, number> {
    const out = new Map<string, number>();
    for (const wa of POOL[targetWA]) {
      const bag = buckets.get(`${target}|${subject}|${wa}`);
      if (!bag) continue;
      for (const [t, n] of bag) out.set(t, (out.get(t) ?? 0) + n);
    }
    if (targetWA === "WA1") {
      const prior = PRIOR_GRADE[target];
      if (prior) {
        const priorEoy = buckets.get(`${prior}|${subject}|EOY`);
        if (priorEoy) for (const [t, n] of priorEoy) out.set(t, (out.get(t) ?? 0) + n);
      }
    }
    if (target === "P6" && (targetWA === "WA3" || targetWA === "EOY")) {
      const psleBag = buckets.get(`PSLE|${subject}|EOY`);
      if (psleBag) for (const [t, n] of psleBag) out.set(t, (out.get(t) ?? 0) + n);
    }
    return out;
  }

  const targetLevels: Level[] = ["P4", "P5", "P6"];
  const subjects = ["Math", "Science", "English"];
  const targetWAs: WA[] = ["WA1", "WA2", "WA3", "EOY"];
  console.log(`Cumulative diagnostic pool — target = (level, subject, WA)`);
  console.log(`Rules: WA1 only, WA2=WA1+WA2, WA3=WA1+WA2+WA3, EOY=WA1..EOY.`);
  console.log(`P6 WA3/EOY also fold in PSLE. P6 WA1/WA2 do NOT.\n`);

  for (const l of targetLevels) {
    for (const s of subjects) {
      console.log(`\n════ ${l} · ${s} ════`);
      for (const wa of targetWAs) {
        const pool = effectivePool(l, s, wa);
        if (pool.size === 0) { console.log(`  ── ${wa} — pool empty ──`); continue; }
        const sorted = [...pool.entries()].sort((a, b) => b[1] - a[1]);
        const top5 = sorted.slice(0, 5);
        const total = sorted.reduce((sum, [, n]) => sum + n, 0);
        const enough = top5.filter(([, n]) => n >= 3).length;
        console.log(`  ── ${wa} pool — ${total} MCQ · ${sorted.length} topics · ${enough}/5 top topics ≥3 MCQ ──`);
        for (const [t, n] of top5) {
          const flag = n < 3 ? " ⚠<3" : "";
          console.log(`      ${t.padEnd(50)}  ${n.toString().padStart(3)}${flag}`);
        }
      }
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
