// Snapshot of how many master-bank questions are still un-tagged
// (examQuestion.subTopic IS NULL) by subject and syllabus topic. Limited
// to MASTER questions (sourceExamId IS NULL on the parent paper, paper
// extractionStatus='ready', paperType IS NULL) — clones inherit the tag
// via the back-propagate script, so master coverage is the universe to
// shrink. Order: subject → topic, by un-tagged count desc within topic.
//
// Usage:
//   npx tsx scripts/_probe-untagged.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        extractionStatus: "ready",
      },
    },
    select: { subTopic: true, syllabusTopic: true, examPaper: { select: { subject: true } } },
  });

  type Key = string;
  const stats = new Map<Key, { total: number; untagged: number }>();
  let totalAll = 0, untaggedAll = 0;
  for (const r of rows) {
    const subjRaw = (r.examPaper.subject ?? "").trim();
    const sl = subjRaw.toLowerCase();
    const subject = sl.includes("chinese") || subjRaw.includes("华文") || subjRaw.includes("中文") || subjRaw.includes("华语")
      ? "Chinese"
      : sl.includes("english") ? "English"
      : sl.includes("math") ? "Math"
      : sl.includes("science") ? "Science"
      : (subjRaw || "(unknown)");
    const topic = r.syllabusTopic ?? "(no syllabus topic)";
    const key = `${subject}|${topic}`;
    const cur = stats.get(key) ?? { total: 0, untagged: 0 };
    cur.total++;
    if (r.subTopic === null) cur.untagged++;
    stats.set(key, cur);
    totalAll++;
    if (r.subTopic === null) untaggedAll++;
  }

  // Group output by subject for readability.
  const bySubject = new Map<string, Array<{ topic: string; total: number; untagged: number }>>();
  for (const [key, v] of stats) {
    const [subject, topic] = key.split("|");
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject)!.push({ topic, total: v.total, untagged: v.untagged });
  }

  const subjectOrder = ["English", "Math", "Science", "Chinese"];
  console.log(`Total master questions: ${totalAll.toLocaleString()}`);
  console.log(`Untagged (subTopic IS NULL): ${untaggedAll.toLocaleString()} (${(untaggedAll / totalAll * 100).toFixed(1)}%)`);
  console.log();

  for (const subject of subjectOrder.concat([...bySubject.keys()].filter(s => !subjectOrder.includes(s)))) {
    const topics = bySubject.get(subject);
    if (!topics) continue;
    const subTotal = topics.reduce((s, t) => s + t.total, 0);
    const subUntagged = topics.reduce((s, t) => s + t.untagged, 0);
    console.log(`── ${subject} — ${subUntagged.toLocaleString()}/${subTotal.toLocaleString()} untagged (${(subUntagged / subTotal * 100).toFixed(1)}%)`);
    topics
      .filter(t => t.untagged > 0)
      .sort((a, b) => b.untagged - a.untagged)
      .slice(0, 25)
      .forEach(t => {
        const pct = (t.untagged / t.total * 100).toFixed(0);
        console.log(`    ${t.topic.padEnd(38)}  ${String(t.untagged).padStart(4)}/${String(t.total).padStart(4)}  (${pct}%)`);
      });
    console.log();
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
