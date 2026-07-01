// MCQ supply per top-5 topic × WA period, honouring:
//   - master-paper-only rule ([[master-paper-only-for-supply]])
//   - PSLE lumped with P6 ([[psle-lumped-with-p6]])
//
// For each (level, subject, WA period): show top 5 topics by MCQ count.
// Flags any topic that can't cover the 3-per-topic diagnostic target.

import "dotenv/config";
import { prisma } from "../src/lib/db";

function normLevel(l: string | null): string {
  if (l === "PSLE" || l === "Primary 6" || l === "P6") return "P6+PSLE";
  if (l === "Primary 5" || l === "P5") return "P5";
  if (l === "Primary 4" || l === "P4") return "P4";
  return l ?? "(none)";
}
function subj(s: string | null): string {
  const l = (s ?? "").toLowerCase();
  if (l.includes("english")) return "English";
  if (l.includes("math")) return "Math";
  if (l.includes("science")) return "Science";
  if (l.includes("chinese")) return "Chinese";
  return "Other";
}
function waOf(title: string): string {
  const t = title.toUpperCase();
  if (t.includes("WA1")) return "WA1";
  if (t.includes("WA2") || t.includes("MID YEAR") || t.includes("SA1")) return "WA2";
  if (t.includes("WA3")) return "WA3";
  if (t.includes("EOY") || t.includes("SA2") || t.includes("END OF YEAR") || t.includes("YEAR END")) return "EOY";
  if (t.includes("PSLE") || t.includes("PRELIMINARY") || t.includes("PRELIM")) return "PSLE";
  return "(unlabelled)";
}

(async () => {
  // Strict: master paper only + master question only
  const rows = await prisma.examQuestion.findMany({
    where: {
      sourceQuestionId: null,
      examPaper: { paperType: null, sourceExamId: null, extractionStatus: "ready" },
      syllabusTopic: { not: null },
    },
    select: {
      syllabusTopic: true, transcribedOptions: true,
      examPaper: { select: { level: true, subject: true, title: true } },
    },
  });

  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2);
  console.log(`Master MCQ rows: ${mcq.length}\n`);

  // Bucket by (normLevel, subject, wa, topic)
  const byBucket = new Map<string, Map<string, number>>();
  for (const r of mcq) {
    const key = `${normLevel(r.examPaper.level)} :: ${subj(r.examPaper.subject)} :: ${waOf(r.examPaper.title ?? "")}`;
    const inner = byBucket.get(key) ?? new Map<string, number>();
    inner.set(r.syllabusTopic ?? "?", (inner.get(r.syllabusTopic ?? "?") ?? 0) + 1);
    byBucket.set(key, inner);
  }

  const levels = ["P4", "P5", "P6+PSLE"];
  const subjs  = ["Math", "Science", "English"];
  const waList = ["WA1", "WA2", "WA3", "EOY", "PSLE", "(unlabelled)"];

  for (const l of levels) {
    for (const s of subjs) {
      console.log(`\n════ ${l} · ${s} ════`);
      for (const wa of waList) {
        const inner = byBucket.get(`${l} :: ${s} :: ${wa}`);
        if (!inner || inner.size === 0) continue;
        const sorted = [...inner.entries()].sort((a, b) => b[1] - a[1]);
        const top5 = sorted.slice(0, 5);
        const enough = top5.filter(([, n]) => n >= 3).length;
        const total = sorted.reduce((sum, [, n]) => sum + n, 0);
        console.log(`  ── ${wa} — total ${total} MCQ across ${sorted.length} topics · ${enough}/5 top topics have ≥3 ──`);
        for (const [t, n] of top5) {
          const flag = n < 3 ? " ⚠<3" : "";
          console.log(`      ${t.padEnd(50)}  ${n.toString().padStart(3)}${flag}`);
        }
      }
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
