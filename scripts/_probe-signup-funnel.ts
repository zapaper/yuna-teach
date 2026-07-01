// Onboarding funnel for the last 150 parent signups.
//
// Stages tracked per parent:
//   1. Signed up (createdAt on the users row, role=PARENT)
//   2. Linked at least one student (parentLinks row exists)
//   3. Any paper ever assigned to that student
//   4. Any paper attempted (at least one question with marksAwarded != null)
//   5. Any paper completed (markingStatus in complete/released)
//
// Slices:
//   - by signup hour-of-day (SGT)
//   - by day-of-week
//   - by signup source if we can derive it (settings.source or utm)
//   - by whether the parent's kid was auto-assigned a nudge-quiz
//   - time to first attempted quiz, in minutes
//
// Run: npx tsx scripts/_probe-signup-funnel.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

const N = 150;

(async () => {
  const parents = await prisma.user.findMany({
    where: { role: "PARENT", email: { not: { contains: "yunateach.com" } } },
    orderBy: { createdAt: "desc" },
    take: N,
    select: {
      id: true, name: true, email: true, createdAt: true, settings: true,
      parentLinks: {
        select: {
          student: {
            select: {
              id: true, name: true, createdAt: true, settings: true,
              assignedExamPapers: {
                where: { NOT: { paperType: "eval" } },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true, createdAt: true, markingStatus: true, paperType: true, subject: true, title: true,
                  questions: { select: { marksAwarded: true }, take: 1 },
                },
              },
            },
          },
        },
      },
    },
  });

  console.log(`Scanned ${parents.length} parents (oldest: ${parents[parents.length - 1]?.createdAt.toISOString().slice(0, 10)}, newest: ${parents[0]?.createdAt.toISOString().slice(0, 10)})`);

  type Row = {
    parentId: string;
    parentEmail: string;
    signupAt: Date;
    signupHourSGT: number;
    signupDOW: string;
    linkedStudent: boolean;
    hasAssignedPaper: boolean;
    hasAttemptedPaper: boolean;
    hasCompletedPaper: boolean;
    minutesToFirstAttempt: number | null;
    nudged: boolean;
    firstPaperType: string | null;
    firstPaperSubject: string | null;
  };

  const rows: Row[] = [];
  for (const p of parents) {
    const signupAt = p.createdAt;
    // SGT = UTC+8. Convert Date to SGT hour.
    const sgtMs = signupAt.getTime() + 8 * 3600_000;
    const sgtDate = new Date(sgtMs);
    const hour = sgtDate.getUTCHours();
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][sgtDate.getUTCDay()];

    const students = p.parentLinks.map(l => l.student).filter(Boolean);
    const linkedStudent = students.length > 0;
    let hasAssignedPaper = false;
    let hasAttemptedPaper = false;
    let hasCompletedPaper = false;
    let firstAttemptAt: Date | null = null;
    let nudged = false;
    let firstPaperType: string | null = null;
    let firstPaperSubject: string | null = null;
    for (const s of students) {
      const stuSettings = s.settings as { activationNudgeSent?: string | boolean } | null;
      if (stuSettings?.activationNudgeSent) nudged = true;
      for (const paper of s.assignedExamPapers) {
        hasAssignedPaper = true;
        if (!firstPaperType) { firstPaperType = paper.paperType; firstPaperSubject = paper.subject; }
        if (paper.questions[0]?.marksAwarded != null) {
          hasAttemptedPaper = true;
          if (!firstAttemptAt || paper.createdAt < firstAttemptAt) firstAttemptAt = paper.createdAt;
        }
        if (paper.markingStatus === "complete" || paper.markingStatus === "released") hasCompletedPaper = true;
      }
    }
    const minutesToFirstAttempt = firstAttemptAt ? (firstAttemptAt.getTime() - signupAt.getTime()) / 60_000 : null;

    rows.push({
      parentId: p.id, parentEmail: p.email ?? "—",
      signupAt, signupHourSGT: hour, signupDOW: dow,
      linkedStudent, hasAssignedPaper, hasAttemptedPaper, hasCompletedPaper,
      minutesToFirstAttempt, nudged, firstPaperType, firstPaperSubject,
    });
  }

  // ── Funnel top-line ──
  const counts = {
    signed: rows.length,
    linked: rows.filter(r => r.linkedStudent).length,
    assigned: rows.filter(r => r.hasAssignedPaper).length,
    attempted: rows.filter(r => r.hasAttemptedPaper).length,
    completed: rows.filter(r => r.hasCompletedPaper).length,
  };
  const pct = (n: number) => `${((n / counts.signed) * 100).toFixed(0)}%`;
  console.log(`\nFunnel:`);
  console.log(`  1. Signed up:         ${counts.signed}   (100%)`);
  console.log(`  2. Linked a student:  ${counts.linked.toString().padStart(3)}   (${pct(counts.linked)})   drop ${counts.signed - counts.linked}`);
  console.log(`  3. Paper assigned:    ${counts.assigned.toString().padStart(3)}   (${pct(counts.assigned)})   drop ${counts.linked - counts.assigned}`);
  console.log(`  4. Any attempt:       ${counts.attempted.toString().padStart(3)}   (${pct(counts.attempted)})   drop ${counts.assigned - counts.attempted}`);
  console.log(`  5. Any completed:     ${counts.completed.toString().padStart(3)}   (${pct(counts.completed)})   drop ${counts.attempted - counts.completed}`);

  // ── Time to first attempt distribution ──
  const times = rows.map(r => r.minutesToFirstAttempt).filter((x): x is number => x != null && x >= 0);
  if (times.length > 0) {
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const buckets = { "<10min": 0, "10-60min": 0, "1-24h": 0, "1-7d": 0, ">7d": 0 };
    for (const t of times) {
      if (t < 10) buckets["<10min"]++;
      else if (t < 60) buckets["10-60min"]++;
      else if (t < 1440) buckets["1-24h"]++;
      else if (t < 10080) buckets["1-7d"]++;
      else buckets[">7d"]++;
    }
    console.log(`\nTime from signup → first attempt (n=${times.length}):`);
    console.log(`  median: ${median < 60 ? `${median.toFixed(0)} min` : median < 1440 ? `${(median / 60).toFixed(1)} h` : `${(median / 1440).toFixed(1)} d`}`);
    for (const [k, v] of Object.entries(buckets)) {
      const bar = "▇".repeat(Math.round(v / times.length * 30));
      console.log(`  ${k.padEnd(9)}  ${v.toString().padStart(3)}  ${bar}`);
    }
  }

  // ── Signup hour distribution (SGT), and attempt rate per hour ──
  console.log(`\nSignup hour (SGT) — with attempt rate:`);
  const byHour = new Map<number, { total: number; attempted: number }>();
  for (const r of rows) {
    const cur = byHour.get(r.signupHourSGT) ?? { total: 0, attempted: 0 };
    cur.total++;
    if (r.hasAttemptedPaper) cur.attempted++;
    byHour.set(r.signupHourSGT, cur);
  }
  for (let h = 0; h < 24; h++) {
    const b = byHour.get(h) ?? { total: 0, attempted: 0 };
    if (b.total === 0) continue;
    const rate = b.attempted / b.total;
    const bar = "▇".repeat(b.total);
    console.log(`  ${String(h).padStart(2, "0")}:00  n=${b.total.toString().padStart(2)}  attempt=${b.attempted.toString().padStart(2)} (${(rate * 100).toFixed(0)}%)  ${bar}`);
  }

  // ── Signup day-of-week, with attempt rate ──
  console.log(`\nSignup day-of-week (SGT):`);
  const byDow = new Map<string, { total: number; attempted: number }>();
  for (const r of rows) {
    const cur = byDow.get(r.signupDOW) ?? { total: 0, attempted: 0 };
    cur.total++;
    if (r.hasAttemptedPaper) cur.attempted++;
    byDow.set(r.signupDOW, cur);
  }
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    const b = byDow.get(d) ?? { total: 0, attempted: 0 };
    if (b.total === 0) continue;
    const rate = b.total > 0 ? b.attempted / b.total : 0;
    console.log(`  ${d}  n=${b.total.toString().padStart(3)}  attempt=${b.attempted.toString().padStart(3)} (${(rate * 100).toFixed(0)}%)`);
  }

  // ── Nudge slice ──
  const nudgedRows = rows.filter(r => r.nudged);
  const nudgedAttempts = nudgedRows.filter(r => r.hasAttemptedPaper).length;
  console.log(`\nNudge slice:`);
  console.log(`  parents whose kid got a Day-3 nudge: ${nudgedRows.length}`);
  console.log(`  … of whom kid attempted a paper:     ${nudgedAttempts} (${nudgedRows.length ? ((nudgedAttempts / nudgedRows.length) * 100).toFixed(0) : 0}%)`);

  // ── First paper subject distribution (among parents who got at least one paper assigned) ──
  const bySubj = new Map<string, { total: number; attempted: number }>();
  for (const r of rows) {
    if (!r.firstPaperSubject) continue;
    const key = r.firstPaperSubject.toLowerCase().includes("english") ? "English"
             : r.firstPaperSubject.toLowerCase().includes("math") ? "Math"
             : r.firstPaperSubject.toLowerCase().includes("science") ? "Science"
             : r.firstPaperSubject.toLowerCase().includes("chinese") || r.firstPaperSubject.includes("华") ? "Chinese"
             : "Other";
    const cur = bySubj.get(key) ?? { total: 0, attempted: 0 };
    cur.total++;
    if (r.hasAttemptedPaper) cur.attempted++;
    bySubj.set(key, cur);
  }
  console.log(`\nFirst paper subject → attempt rate:`);
  for (const [k, b] of bySubj) {
    console.log(`  ${k.padEnd(8)}  n=${b.total.toString().padStart(3)}  attempted=${b.attempted.toString().padStart(3)} (${((b.attempted / b.total) * 100).toFixed(0)}%)`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
