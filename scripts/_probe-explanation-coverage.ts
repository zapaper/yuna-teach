// Coverage of AI-explanation ("elaboration") field on master MCQs
// per (level, subject). Shows how many MCQ masters have elaboration
// populated vs blank — surfaces the gaps we need to backfill.

import "dotenv/config";
import { prisma } from "../src/lib/db";

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
  if (l.includes("chinese")) return "Chinese";
  return "Other";
}

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      examPaper: { paperType: null, sourceExamId: null, extractionStatus: "ready" },
    },
    select: {
      elaboration: true, transcribedOptions: true,
      examPaper: { select: { level: true, subject: true } },
    },
  });
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2);
  console.log(`Master MCQ rows: ${mcq.length}\n`);

  const stat = new Map<string, { total: number; withElab: number }>();
  for (const r of mcq) {
    const key = `${normLevel(r.examPaper.level)} · ${subj(r.examPaper.subject)}`;
    const cur = stat.get(key) ?? { total: 0, withElab: 0 };
    cur.total++;
    if ((r.elaboration ?? "").trim().length > 20) cur.withElab++;
    stat.set(key, cur);
  }
  const rowsOut = [...stat.entries()].sort();
  const totalAll = rowsOut.reduce((s, [, v]) => s + v.total, 0);
  const withAll  = rowsOut.reduce((s, [, v]) => s + v.withElab, 0);
  console.log(`Coverage per (level, subject):`);
  console.log(`  ${"level · subject".padEnd(20)}  total  filled  gap    %`);
  for (const [key, v] of rowsOut) {
    const gap = v.total - v.withElab;
    const pct = v.total > 0 ? (v.withElab / v.total * 100).toFixed(0) : "0";
    const flag = gap > 0 ? " ⚠" : "";
    console.log(`  ${key.padEnd(20)}  ${v.total.toString().padStart(5)}  ${v.withElab.toString().padStart(6)}  ${gap.toString().padStart(4)}   ${pct.padStart(3)}%${flag}`);
  }
  console.log(`  ${"TOTAL".padEnd(20)}  ${totalAll.toString().padStart(5)}  ${withAll.toString().padStart(6)}  ${(totalAll - withAll).toString().padStart(4)}   ${(withAll / totalAll * 100).toFixed(0).padStart(3)}%`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
