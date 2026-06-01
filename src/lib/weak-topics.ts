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
//   2. Group by (normalised subject, syllabusTopic). Require ≥5
//      questions per bucket so we don't surface noise.
//   3. Compute overall % = awarded / available across the bucket.
//   4. Recent-trend: average of the last 5 questions (chronological
//      by examPaper.completedAt) vs the last 10. If last-5 ≥ last-10
//      + 5 percentage points → mark as improving (green up arrow).
//   5. Sort ascending by overall %, return the top N.

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
  sample: number;     // questions seen on this topic
  improving: boolean; // last-5 avg ≥ last-10 avg + 5 percentage points
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
        select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true },
      },
    },
  });

  type Bucket = {
    subject: string;
    topic: string;
    items: { pct: number }[];   // chronological order, per question
    awarded: number;
    available: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const p of papers) {
    // Revision-mode papers re-quiz past mistakes; counting them double-
    // counts the wrong answers and drops the weak-topic averages.
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue;

    const subject = bucketSubject(p.subject);
    if (subject === "Other") continue;

    for (const q of p.questions) {
      const topic = q.syllabusTopic ?? "";
      if (!topic) continue;
      const avail = Number(q.marksAvailable);
      const awardedRaw = q.marksAwarded;
      if (awardedRaw == null || !Number.isFinite(avail) || avail <= 0) continue;
      const awarded = Number(awardedRaw);

      const key = `${subject}|${topic}`;
      const b = buckets.get(key) ?? { subject, topic, items: [], awarded: 0, available: 0 };
      b.awarded += awarded;
      b.available += avail;
      b.items.push({ pct: (awarded / avail) * 100 });
      buckets.set(key, b);
    }
  }

  const rows: WeakTopicRow[] = [];
  for (const b of buckets.values()) {
    if (b.items.length < MIN_SAMPLE) continue;
    if (b.available === 0) continue;
    const overall = (b.awarded / b.available) * 100;
    const recent = b.items.slice(-10);
    const last5 = recent.slice(-5);
    const last10Pct = recent.length >= MIN_SAMPLE
      ? recent.reduce((s, x) => s + x.pct, 0) / recent.length
      : null;
    const last5Pct = last5.length >= 3
      ? last5.reduce((s, x) => s + x.pct, 0) / last5.length
      : null;
    const improving = last5Pct != null && last10Pct != null && (last5Pct - last10Pct) >= IMPROVING_DELTA;
    rows.push({ subject: b.subject, topic: b.topic, pct: overall, sample: b.items.length, improving });
  }
  rows.sort((a, b) => a.pct - b.pct);
  return rows.slice(0, limit);
}
