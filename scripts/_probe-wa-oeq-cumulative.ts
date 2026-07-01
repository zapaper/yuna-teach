// OEQ (non-MCQ) supply per (level, subject, WA period), same rules
// as _probe-wa-mcq-cumulative.ts:
//   - Master paper only (paperType null, sourceExamId null, ready)
//   - Master question only (sourceQuestionId null)
//   - Cumulative period pool (WA2 = WA1+WA2, etc.)
//   - WA1 folds in prior-grade EOY
//   - P6 WA3/EOY folds in PSLE; P6 WA1/WA2 excludes PSLE
//   - Basic-ops questions use their new subTopic as the effective topic
//
// "OEQ" here = master question with EMPTY transcribedOptions but a
// real stem or diagram (i.e. an open-ended, typed/handwritten answer).

import "dotenv/config";
import { prisma } from "../src/lib/db";

type WA = "WA1" | "WA2" | "WA3" | "EOY";
type Level = "P4" | "P5" | "P6";
const POOL: Record<WA, WA[]> = { WA1: ["WA1"], WA2: ["WA1", "WA2"], WA3: ["WA1", "WA2", "WA3"], EOY: ["WA1", "WA2", "WA3", "EOY"] };
const PRIOR_GRADE: Record<Level, string | null> = { P4: "P3", P5: "P4", P6: "P5" };

function normLevel(l: string | null): string {
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
      transcribedStem: true, diagramImageData: true,
      examPaper: { select: { level: true, subject: true, title: true } },
    },
  });
  // OEQ filter: empty options + has stem OR diagram
  const oeq = rows.filter(r => {
    const opts = r.transcribedOptions;
    const noOpts = !Array.isArray(opts) || opts.length === 0;
    const hasContent = (r.transcribedStem ?? "").trim().length > 15 || (r.diagramImageData?.length ?? 0) > 0;
    return noOpts && hasContent;
  });
  console.log(`Master OEQ (empty options + has stem/diagram) rows: ${oeq.length}\n`);

  const effectiveTopic = (r: (typeof oeq)[number]): string => {
    const st = r.syllabusTopic ?? "?";
    if (st !== "Basic math operations" && st !== "Basic Math Operations") return st;
    return r.subTopic ?? st;
  };

  const buckets = new Map<string, Map<string, number>>();
  for (const r of oeq) {
    const rawLevel = normLevel(r.examPaper.level);
    const subject = subj(r.examPaper.subject);
    const wa = rawLevel === "PSLE" ? "EOY" : waOf(r.examPaper.title ?? "");
    if (rawLevel === "(none)" || subject === "Other" || wa === "(unlabelled)") continue;
    const key = `${rawLevel}|${subject}|${wa}`;
    const bag = buckets.get(key) ?? new Map<string, number>();
    const t = effectiveTopic(r);
    bag.set(t, (bag.get(t) ?? 0) + 1);
    buckets.set(key, bag);
  }

  function pool(target: Level, subject: string, targetWA: WA): Map<string, number> {
    const out = new Map<string, number>();
    for (const wa of POOL[targetWA]) {
      const bag = buckets.get(`${target}|${subject}|${wa}`);
      if (!bag) continue;
      for (const [t, n] of bag) out.set(t, (out.get(t) ?? 0) + n);
    }
    if (targetWA === "WA1") {
      const prior = PRIOR_GRADE[target];
      if (prior) {
        const bag = buckets.get(`${prior}|${subject}|EOY`);
        if (bag) for (const [t, n] of bag) out.set(t, (out.get(t) ?? 0) + n);
      }
    }
    if (target === "P6" && (targetWA === "WA3" || targetWA === "EOY")) {
      const bag = buckets.get(`PSLE|${subject}|EOY`);
      if (bag) for (const [t, n] of bag) out.set(t, (out.get(t) ?? 0) + n);
    }
    return out;
  }

  // OEQ target: 1 per top-5 topic (5 questions total per diagnostic)
  const TARGET = 1;
  const levels: Level[] = ["P4", "P5", "P6"];
  const subjects = ["Math", "Science"] as const;   // English uses typed synthesis separately
  const waTargets: WA[] = ["WA1", "WA2", "WA3", "EOY"];

  for (const l of levels) {
    for (const s of subjects) {
      console.log(`\n════ ${l} · ${s} — OEQ diagnostic (target: 1 per top-5 topic) ════`);
      for (const wa of waTargets) {
        const p = pool(l, s, wa);
        if (p.size === 0) { console.log(`  ── ${wa} pool empty ──`); continue; }
        const sorted = [...p.entries()].sort((a, b) => b[1] - a[1]);
        const top5 = sorted.slice(0, 5);
        const total = sorted.reduce((sum, [, n]) => sum + n, 0);
        const enough = top5.filter(([, n]) => n >= TARGET).length;
        console.log(`  ── ${wa} pool — ${total} OEQ · ${sorted.length} topics · ${enough}/5 top topics ≥${TARGET} ──`);
        for (const [t, n] of top5) {
          const flag = n < TARGET ? " ⚠<1" : "";
          console.log(`      ${t.padEnd(50)}  ${n.toString().padStart(3)}${flag}`);
        }
      }
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
