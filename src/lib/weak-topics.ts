// Top-N weak topics per student. Used by the AI Smart Insights card
// on the parent dashboard to surface where the child is losing
// marks, with a recent-trend indicator so an improving topic doesn't
// look like a panic signal.
//
// Scoping is intentionally aligned with /api/student-progress (the
// route the Focus Practice "Weakest Topics" panel reads from) so
// both surfaces report the same numbers:
//   · markingStatus IN (complete, released) only — pending/failed
//     papers don't pollute the average.
//   · Revision-mode papers (metadata.revisionMode set) are excluded
//     — they're a curated set of past mistakes, so counting them
//     would double-count failures and drop the score artificially.
//   · Subject normalised via bucketSubject (English Language →
//     English, etc.) so "English Language" rows don't form their
//     own bucket separate from "English".
//
// Algorithm:
//   1. Pull every marked question on the student's papers that pass
//      the scope above.
//   2. Group by (normalised subject, syllabusTopic). DEDUPE attempts
//      to the most-recent attempt per source question — re-doing the
//      same question 4× shouldn't be 4× the data points; it should be
//      1 data point reflecting the child's current skill on that
//      question. Falls back to the row's own id when sourceQuestionId
//      is null (direct attempts on master papers — already unique).
//   3. Require ≥5 UNIQUE questions per bucket so we don't surface noise.
//   4. Compute overall % = sum of latest-awarded / sum of latest-available
//      across the unique questions in the bucket.
//   5. Recent-trend: average of the most recent 10 unique questions
//      (chronological by completedAt of their latest attempt) vs the
//      per-question average across ALL unique questions. If recent-10
//      is ≥5 percentage points above the lifetime per-question average,
//      mark improving (green up arrow). With ≤10 unique questions the
//      slice equals the full set — delta = 0 → improving stays false.
//   6. Sort ascending by overall %, return the top N.

import { prisma } from "@/lib/db";

// Mirror src/app/api/student-progress/route.ts so both surfaces
// classify subjects identically.
function bucketSubject(raw: string | null | undefined): "Math" | "Science" | "English" | "Chinese" | "Other" {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("math")) return "Math";
  if (lower.includes("science") || lower.includes("sci")) return "Science";
  if (lower.includes("english") || lower.includes("eng")) return "English";
  if (lower.includes("chinese") || lower.includes("华文")) return "Chinese";
  return "Other";
}

export type WeakTopicRow = {
  subject: string;
  topic: string;
  pct: number;        // overall % score on this topic
  sample: number;     // unique questions seen on this topic
  improving: boolean; // recent-10 unique avg ≥ lifetime per-q avg + 5 percentage points
};

const MIN_SAMPLE = 5;
const IMPROVING_DELTA = 5;

export async function getWeakTopics(studentId: string, limit = 5): Promise<WeakTopicRow[]> {
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      markingStatus: { in: ["complete", "released"] },
    },
    orderBy: { completedAt: "asc" },
    select: {
      subject: true, completedAt: true, metadata: true,
      questions: {
        select: {
          id: true,
          sourceQuestionId: true,
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
        },
      },
    },
  });

  type Attempt = { awarded: number; available: number; pct: number; completedAt: Date };
  type Bucket = {
    subject: string;
    topic: string;
    // Keyed by sourceQuestionId (or the question's own id if no source).
    // Holds the LATEST attempt per unique source question.
    latestBySource: Map<string, Attempt>;
  };
  const buckets = new Map<string, Bucket>();

  for (const p of papers) {
    // Revision-mode papers re-quiz past mistakes; counting them double-
    // counts the wrong answers and drops the weak-topic averages.
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue;

    const subject = bucketSubject(p.subject);
    if (subject === "Other") continue;
    const paperCompletedAt = p.completedAt ?? new Date(0);

    for (const q of p.questions) {
      const topic = q.syllabusTopic ?? "";
      if (!topic) continue;
      const avail = Number(q.marksAvailable);
      const awardedRaw = q.marksAwarded;
      if (awardedRaw == null || !Number.isFinite(avail) || avail <= 0) continue;
      const awarded = Number(awardedRaw);

      const bucketKey = `${subject}|${topic}`;
      const b = buckets.get(bucketKey) ?? { subject, topic, latestBySource: new Map<string, Attempt>() };
      // Use the source question id when present (clones from quizzes /
      // focused tests / mastery point at the bank source row). Falls
      // back to the row's own id for direct master-paper attempts.
      const sourceKey = q.sourceQuestionId ?? q.id;
      const existing = b.latestBySource.get(sourceKey);
      if (!existing || paperCompletedAt > existing.completedAt) {
        b.latestBySource.set(sourceKey, {
          awarded, available: avail,
          pct: (awarded / avail) * 100,
          completedAt: paperCompletedAt,
        });
      }
      buckets.set(bucketKey, b);
    }
  }

  const rows: WeakTopicRow[] = [];
  for (const b of buckets.values()) {
    const items = [...b.latestBySource.values()]
      .sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    if (items.length < MIN_SAMPLE) continue;
    const totalAwarded = items.reduce((s, x) => s + x.awarded, 0);
    const totalAvailable = items.reduce((s, x) => s + x.available, 0);
    if (totalAvailable === 0) continue;
    const overall = (totalAwarded / totalAvailable) * 100;
    // Improving signal: avg of recent-10 unique questions vs lifetime
    // per-question average. With ≤10 unique items the slice equals the
    // full set — delta = 0 → improving stays false.
    const recent = items.slice(-10);
    const recentPct = recent.reduce((s, x) => s + x.pct, 0) / recent.length;
    const overallPerQ = items.reduce((s, x) => s + x.pct, 0) / items.length;
    const improving = (recentPct - overallPerQ) >= IMPROVING_DELTA;
    rows.push({ subject: b.subject, topic: b.topic, pct: overall, sample: items.length, improving });
  }
  rows.sort((a, b) => a.pct - b.pct);
  return rows.slice(0, limit);
}
