// V2 supply probe — fixes:
//   1. Synthesis has two label variants ("Synthesis / Transformation" +
//      "Synthesis & Transformation"). V1 only counted the second.
//   2. English papers may exist at P4/P5 under other extractionStatus
//      values or with slightly different subject text. Widen the search.
//   3. WA1/WA2/WA3 frequency: for P4/P5 Math + Science, show the top 5
//      topics per WA period and their MCQ counts.

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // 1) English paper inventory across all extractionStatus values.
  console.log(`===== English paper inventory (ALL extractionStatus) =====`);
  const engPapers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      subject: { contains: "english", mode: "insensitive" },
    },
    select: { id: true, title: true, level: true, extractionStatus: true, paperType: true },
    orderBy: [{ level: "asc" }, { title: "asc" }],
  });
  const byLevelStatus = new Map<string, number>();
  for (const p of engPapers) {
    const k = `${p.level ?? "(null)"} · ${p.extractionStatus ?? "(null)"} · ${p.paperType ?? "master"}`;
    byLevelStatus.set(k, (byLevelStatus.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byLevelStatus.entries()].sort()) console.log(`  ${k}  →  ${n}`);
  const p4p5Eng = engPapers.filter(p => p.level === "Primary 4" || p.level === "Primary 5");
  console.log(`\n  P4/P5 English papers (any status): ${p4p5Eng.length}`);
  for (const p of p4p5Eng.slice(0, 10)) console.log(`    ${p.level}  ${p.extractionStatus}  ${p.paperType ?? "master"}  ${p.title}`);

  // 2) Synthesis supply — both label variants, all levels.
  console.log(`\n===== Synthesis supply (both label variants) =====`);
  const synth = await prisma.examQuestion.findMany({
    where: {
      examPaper: { sourceExamId: null, paperType: null, extractionStatus: "ready" },
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
    },
    select: {
      subTopic: true, transcribedOptions: true, syllabusTopic: true,
      examPaper: { select: { level: true } },
    },
  });
  console.log(`Total synthesis master rows: ${synth.length}`);
  const bySub = new Map<string, number>();
  for (const s of synth) bySub.set(s.subTopic ?? "(untagged)", (bySub.get(s.subTopic ?? "(untagged)") ?? 0) + 1);
  console.log(`  by sub-topic:`);
  for (const [k, n] of [...bySub.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(30)}  ${n}`);
  const byLevel = new Map<string, number>();
  for (const s of synth) byLevel.set(s.examPaper.level ?? "(null)", (byLevel.get(s.examPaper.level ?? "(null)") ?? 0) + 1);
  console.log(`  by level:`);
  for (const [k, n] of byLevel) console.log(`    ${k.padEnd(15)}  ${n}`);

  // 3) WA1/WA2/WA3 top-5 topics per period, MCQ only.
  console.log(`\n===== WA1/WA2/WA3 top-5 topics (MCQ) — P4 + P5 =====`);
  function labelOf(title: string): string {
    const t = title.toUpperCase();
    if (t.includes("WA1")) return "WA1";
    if (t.includes("WA2") || t.includes("MID YEAR") || t.includes("SA1")) return "WA2";
    if (t.includes("WA3")) return "WA3";
    if (t.includes("EOY") || t.includes("SA2") || t.includes("END OF YEAR") || t.includes("YEAR END")) return "EOY";
    return "(unlabelled)";
  }
  for (const level of ["Primary 4", "Primary 5"] as const) {
    for (const subj of ["Math", "Science"] as const) {
      const rows = await prisma.examQuestion.findMany({
        where: {
          examPaper: {
            sourceExamId: null, paperType: null, extractionStatus: "ready",
            level, subject: { contains: subj.toLowerCase(), mode: "insensitive" },
          },
          syllabusTopic: { not: null },
        },
        select: {
          syllabusTopic: true, transcribedOptions: true,
          examPaper: { select: { title: true } },
        },
      });
      const mcqRows = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length > 0);
      const byWA = new Map<string, Map<string, number>>();
      for (const r of mcqRows) {
        const wa = labelOf(r.examPaper.title ?? "");
        const m = byWA.get(wa) ?? new Map<string, number>();
        m.set(r.syllabusTopic ?? "?", (m.get(r.syllabusTopic ?? "?") ?? 0) + 1);
        byWA.set(wa, m);
      }
      for (const wa of ["WA1", "WA2", "WA3", "EOY", "(unlabelled)"]) {
        const m = byWA.get(wa);
        if (!m || m.size === 0) continue;
        const top5 = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`\n── ${level} ${subj} ${wa} — top-5 hot topics (MCQ) ──`);
        for (const [t, n] of top5) {
          const flag = n < 3 ? " ⚠<3" : "";
          console.log(`    ${t.padEnd(52)}  ${n.toString().padStart(3)}${flag}`);
        }
      }
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
