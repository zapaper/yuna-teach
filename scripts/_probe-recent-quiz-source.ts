// Are the recent new quiz attempts coming from the Day-3 nudge?
//
// Method:
//   1. Pull every quiz paper created since the nudge campaign started
//      (2026-06-27), with at least one attempted question.
//   2. Bucket the attempting kid:
//        a. nudged + attempted the auto-quiz that the nudge created
//        b. nudged + attempted a different quiz
//        c. NOT nudged (organic activity)
//   3. Show counts + a few sample rows per bucket.
//
// Heuristic for "auto-quiz from nudge": the cron creates the quiz at
// the nudge timestamp, with subject=English and english sections =
// grammar-mcq + vocab-mcq. So a quiz paper whose createdAt is within
// ±2 min of activationNudgeSent AND assignedToId matches → almost
// certainly the auto-quiz.

import "dotenv/config";
import { prisma } from "../src/lib/db";

const CAMPAIGN_START = new Date("2026-06-27T00:00:00Z");

(async () => {
  // 1) Nudged kids + their nudge timestamp.
  const nudged = await prisma.$queryRaw<Array<{ id: string; sent_at: string }>>`
    SELECT id, "settings"->>'activationNudgeSent' AS sent_at
    FROM users
    WHERE "settings" ? 'activationNudgeSent'
      AND "settings"->>'activationNudgeSent' IS NOT NULL
      AND "settings"->>'activationNudgeSent' <> 'false'
  `;
  const nudgeAt = new Map<string, Date>();
  for (const n of nudged) {
    const d = new Date(n.sent_at);
    if (!isNaN(d.getTime())) nudgeAt.set(n.id, d);
  }
  console.log(`Nudged kids on record: ${nudgeAt.size}`);

  // 2) Quiz/focused papers created since campaign start that have at
  //    least one attempted question.
  const recentPapers = await prisma.examPaper.findMany({
    where: {
      createdAt: { gte: CAMPAIGN_START },
      paperType: { in: ["quiz", "focused"] },
      NOT: { paperType: "eval" },
    },
    select: {
      id: true, title: true, createdAt: true, paperType: true,
      assignedToId: true, subject: true, metadata: true,
      questions: { select: { marksAwarded: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });

  // Filter to only attempted ones.
  const attempted = recentPapers.filter(p => p.questions[0]?.marksAwarded != null);
  console.log(`Quiz/focused papers created since ${CAMPAIGN_START.toISOString()}: ${recentPapers.length} (${attempted.length} attempted)`);

  type Bucket = "nudge-auto-quiz" | "nudged-other" | "organic";
  const buckets: Record<Bucket, Array<{ paper: typeof attempted[number]; daysSinceNudge: number | null }>> = {
    "nudge-auto-quiz": [],
    "nudged-other": [],
    "organic": [],
  };

  for (const p of attempted) {
    if (!p.assignedToId) { buckets.organic.push({ paper: p, daysSinceNudge: null }); continue; }
    const sentAt = nudgeAt.get(p.assignedToId);
    if (!sentAt) { buckets.organic.push({ paper: p, daysSinceNudge: null }); continue; }
    const dt = (p.createdAt.getTime() - sentAt.getTime()) / 60_000; // minutes
    const days = (p.createdAt.getTime() - sentAt.getTime()) / 86_400_000;
    // Auto-quiz created within ±2 min of the nudge, subject English, type quiz
    const isAuto =
      Math.abs(dt) <= 2 &&
      p.paperType === "quiz" &&
      (p.subject ?? "").toLowerCase().includes("english");
    if (isAuto) buckets["nudge-auto-quiz"].push({ paper: p, daysSinceNudge: days });
    else buckets["nudged-other"].push({ paper: p, daysSinceNudge: days });
  }

  // Unique-kid counts.
  const uniq = (rows: typeof buckets["nudge-auto-quiz"]) => new Set(rows.map(r => r.paper.assignedToId).filter(Boolean)).size;
  console.log(`\nQuizzes attempted since campaign start:`);
  console.log(`  nudge auto-quiz (the one the email linked to): ${buckets["nudge-auto-quiz"].length} papers, ${uniq(buckets["nudge-auto-quiz"])} unique kids`);
  console.log(`  nudged kid + different quiz                    : ${buckets["nudged-other"].length} papers, ${uniq(buckets["nudged-other"])} unique kids`);
  console.log(`  organic (not nudged)                            : ${buckets.organic.length} papers, ${uniq(buckets.organic)} unique kids`);

  // Show first 5 samples per bucket.
  for (const b of ["nudge-auto-quiz", "nudged-other", "organic"] as Bucket[]) {
    if (buckets[b].length === 0) continue;
    console.log(`\n  Samples (${b}):`);
    for (const r of buckets[b].slice(0, 5)) {
      const day = r.daysSinceNudge != null ? `+${r.daysSinceNudge.toFixed(1)}d` : "—";
      console.log(`    ${r.paper.createdAt.toISOString().slice(0, 16)}  ${day.padStart(7)}  ${(r.paper.subject ?? "?").padEnd(8)}  ${r.paper.paperType.padEnd(7)}  ${r.paper.title.slice(0, 60)}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
