// Average marks graded per day, by 7 / 30 / 90 / all-time windows.
// "Marks graded" = sum of examQuestion.marksAvailable where the parent
// paper reached markingStatus complete|released, excluding eval +
// revision-mode papers (same universe as the "55K marks" hero stat).
//
// Attributes each question to the day the paper was marked. Falls back
// to paper.completedAt, then paper.createdAt, since not every paper has
// markedAt populated.
//
// Run: npx tsx scripts/_probe-marks-per-day.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // Pull marked papers with a timestamp we can bucket on.
  const papers = await prisma.examPaper.findMany({
    where: {
      markingStatus: { in: ["complete", "released"] },
      NOT: { paperType: "eval" },
    },
    select: {
      id: true, createdAt: true, completedAt: true, metadata: true,
    },
  });
  const dayFor = new Map<string, Date>();
  for (const p of papers) {
    const meta = (p.metadata ?? {}) as { revisionMode?: string };
    if (meta.revisionMode) continue;
    // Prefer completedAt (real marking-done time); fall back to createdAt.
    const t = p.completedAt ?? p.createdAt;
    dayFor.set(p.id, t);
  }
  console.log(`Marked non-eval, non-revision papers: ${dayFor.size}`);

  // Now roll up marks-available per day.
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: [...dayFor.keys()] },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
    },
    select: { examPaperId: true, marksAvailable: true },
  });
  const perDay = new Map<string, { marks: number; questions: number }>();
  for (const q of qs) {
    const t = dayFor.get(q.examPaperId);
    if (!t) continue;
    const day = t.toISOString().slice(0, 10);
    const cur = perDay.get(day) ?? { marks: 0, questions: 0 };
    cur.marks += q.marksAvailable ?? 0;
    cur.questions += 1;
    perDay.set(day, cur);
  }

  const days = [...perDay.keys()].sort();
  const first = days[0];
  const last = days[days.length - 1];
  const totalMarks = [...perDay.values()].reduce((s, d) => s + d.marks, 0);
  const totalQs = [...perDay.values()].reduce((s, d) => s + d.questions, 0);
  console.log(`\nSpan: ${first} → ${last}  (${days.length} distinct days)`);
  console.log(`Total marks graded: ${totalMarks.toLocaleString()}`);
  console.log(`Total questions marked: ${totalQs.toLocaleString()}`);

  const now = Date.now();
  function windowAvg(daysBack: number) {
    const from = new Date(now - daysBack * 86_400_000).toISOString().slice(0, 10);
    let marks = 0, qs = 0, active = 0;
    for (const [d, v] of perDay) {
      if (d < from) continue;
      marks += v.marks;
      qs += v.questions;
      active++;
    }
    return { marks, qs, active, wallDays: daysBack };
  }
  const windows = [
    { name: "Last 7 days ", w: windowAvg(7) },
    { name: "Last 30 days", w: windowAvg(30) },
    { name: "Last 90 days", w: windowAvg(90) },
  ];
  console.log(`\nRolling averages (dividing by CALENDAR days, i.e. including zero-activity days):`);
  for (const { name, w } of windows) {
    const perDayMarks = w.marks / w.wallDays;
    const perDayQ = w.qs / w.wallDays;
    console.log(`  ${name}  ${w.marks.toLocaleString().padStart(7)} marks  ·  ${perDayMarks.toFixed(0).padStart(5)}/day  ·  ${perDayQ.toFixed(0).padStart(5)} qs/day  (${w.active}/${w.wallDays} days had activity)`);
  }

  // All-time average across the span
  const spanDays = (new Date(last).getTime() - new Date(first).getTime()) / 86_400_000 + 1;
  console.log(`\nAll-time average across ${spanDays.toFixed(0)}-day span:`);
  console.log(`  ${(totalMarks / spanDays).toFixed(0)} marks/day`);
  console.log(`  ${(totalQs / spanDays).toFixed(0)} questions/day`);

  // Recent daily detail — last 14 days
  console.log(`\nLast 14 days:`);
  const recent = days.slice(-14);
  for (const d of recent) {
    const v = perDay.get(d)!;
    const bar = "▇".repeat(Math.round(v.marks / 100));
    console.log(`  ${d}  ${v.marks.toString().padStart(5)} marks  ${v.questions.toString().padStart(4)} qs  ${bar}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
