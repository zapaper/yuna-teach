// Top-N weak topics per student. Used by the AI Smart Insights card
// on the parent dashboard to surface where the child is losing
// marks, with a recent-trend indicator so an improving topic doesn't
// look like a panic signal.
//
// Algorithm:
//   1. Pull every marked question on the student's completed papers.
//   2. Group by (subject, syllabusTopic). Require ≥5 questions per
//      bucket so we don't surface noise.
//   3. Compute overall % = awarded / available across the bucket.
//   4. Recent-trend: average of the last 5 questions (chronological
//      by examPaper.completedAt) vs the last 10. If last-5 ≥ last-10
//      + 5 percentage points → mark as improving (green up arrow).
//   5. Sort ascending by overall %, return the top N.

import { prisma } from "@/lib/db";

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
  const qs = await prisma.examQuestion.findMany({
    where: {
      marksAwarded: { not: null },
      marksAvailable: { not: null },
      examPaper: { assignedToId: studentId, completedAt: { not: null } },
    },
    select: {
      syllabusTopic: true,
      marksAwarded: true, marksAvailable: true,
      examPaper: { select: { subject: true, completedAt: true } },
    },
    orderBy: { examPaper: { completedAt: "asc" } },
  });

  type Bucket = {
    subject: string;
    topic: string;
    items: { pct: number }[];   // chronological order
    awarded: number;
    available: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const q of qs) {
    const subject = (q.examPaper.subject ?? "").trim();
    const topic = q.syllabusTopic ?? "";
    if (!subject || !topic) continue;
    const key = `${subject}|${topic}`;
    const b = buckets.get(key) ?? { subject, topic, items: [], awarded: 0, available: 0 };
    const avail = Number(q.marksAvailable);
    const awarded = Number(q.marksAwarded);
    b.awarded += awarded;
    b.available += avail;
    b.items.push({ pct: avail > 0 ? (awarded / avail) * 100 : 0 });
    buckets.set(key, b);
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
