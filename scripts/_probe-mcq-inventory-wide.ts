// Wider MCQ inventory: count every ExamQuestion that IS a master
// (sourceQuestionId=null) and has non-empty transcribedOptions, no
// matter what paper type it lives on. Previous probe only counted
// master PAPERS; masters that live inside mastery/focused/quiz papers
// were dropped.
//
// Run: npx tsx scripts/_probe-mcq-inventory-wide.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // Grab everything with source=null (this row is itself a master).
  const rows = await prisma.examQuestion.findMany({
    where: { sourceQuestionId: null },
    select: {
      id: true, syllabusTopic: true, subTopic: true, transcribedOptions: true,
      examPaper: { select: { level: true, subject: true, paperType: true, extractionStatus: true } },
    },
  });
  console.log(`Total sourceQuestionId=null rows: ${rows.length}`);
  const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2);
  console.log(`… of which MCQ (options ≥ 2): ${mcq.length}`);

  // By paperType (why previous filter missed them)
  const byType = new Map<string, number>();
  for (const r of mcq) {
    const k = r.examPaper.paperType ?? "master";
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }
  console.log(`\nMCQ masters by paperType:`);
  for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)}  ${n}`);

  // Bucket function
  function subj(s: string | null): string {
    const l = (s ?? "").toLowerCase();
    if (l.includes("english")) return "English";
    if (l.includes("math")) return "Math";
    if (l.includes("science")) return "Science";
    if (l.includes("chinese")) return "Chinese";
    return "Other";
  }
  function lvl(l: string | null): string {
    if (l === "Primary 4") return "P4";
    if (l === "Primary 5") return "P5";
    if (l === "Primary 6" || l === "P6") return "P6";
    if (l === "PSLE") return "PSLE";
    return l ?? "(none)";
  }

  // Coverage per (subject, level, topic) — the number the diagnostic
  // actually cares about.
  const byCombo = new Map<string, number>();
  for (const r of mcq) {
    const s = subj(r.examPaper.subject);
    const l = lvl(r.examPaper.level);
    const t = r.syllabusTopic ?? "(no topic)";
    const k = `${l} ${s} :: ${t}`;
    byCombo.set(k, (byCombo.get(k) ?? 0) + 1);
  }

  // Top-line: how many topics have ≥3 MCQ per (level, subject)?
  console.log(`\nTopics with ≥3 MCQ per (level, subject) — the diagnostic supply:`);
  const bySL = new Map<string, { topics: number; withN: Map<number, number> }>();
  const byTopicSL: Record<string, Array<[string, number]>> = {};
  for (const [k, n] of byCombo) {
    const [ls, topic] = k.split(" :: ");
    if (!bySL.has(ls)) bySL.set(ls, { topics: 0, withN: new Map() });
    if (!byTopicSL[ls]) byTopicSL[ls] = [];
    byTopicSL[ls].push([topic, n]);
  }
  for (const [ls, arr] of Object.entries(byTopicSL)) {
    arr.sort((a, b) => b[1] - a[1]);
    const totalTopics = arr.length;
    const with3 = arr.filter(([, n]) => n >= 3).length;
    console.log(`\n── ${ls} — ${arr.reduce((s, [, n]) => s + n, 0)} MCQ across ${totalTopics} topics, ${with3} topics have ≥3 ──`);
    for (const [t, n] of arr.slice(0, 15)) {
      const flag = n < 3 ? " ⚠<3" : "";
      console.log(`    ${t.padEnd(52)}  ${n.toString().padStart(3)}${flag}`);
    }
    if (arr.length > 15) console.log(`    … +${arr.length - 15} more topics`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
