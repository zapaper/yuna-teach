// Find Ruthie's weak topics — aggregate her marked questions by
// syllabusTopic, compute mark-loss %, list her bottom topics.

import { prisma } from "../src/lib/db";

async function main() {
  const ruth = await prisma.user.findFirst({
    where: {
      name: { contains: "ruthie", mode: "insensitive" },
      role: "STUDENT",
    },
    select: { id: true, name: true, level: true },
  });
  if (!ruth) { console.log("no student named Ruthie"); return; }
  console.log(`student: ${ruth.name}  (P${ruth.level})  id=${ruth.id}\n`);

  const qs = await prisma.examQuestion.findMany({
    where: {
      marksAwarded: { not: null },
      marksAvailable: { not: null },
      examPaper: { assignedToId: ruth.id, completedAt: { not: null } },
    },
    select: {
      syllabusTopic: true,
      subTopic: true,
      marksAwarded: true,
      marksAvailable: true,
      examPaper: { select: { subject: true } },
    },
  });
  console.log(`marked questions across completed papers: ${qs.length}\n`);

  type Stat = { topic: string; subject: string; count: number; awarded: number; available: number };
  const byTopic = new Map<string, Stat>();
  for (const q of qs) {
    const topic = q.syllabusTopic ?? "(uncategorised)";
    const subject = (q.examPaper.subject ?? "").trim();
    const key = `${subject}|${topic}`;
    const s = byTopic.get(key) ?? { topic, subject, count: 0, awarded: 0, available: 0 };
    s.count++;
    s.awarded += Number(q.marksAwarded);
    s.available += Number(q.marksAvailable);
    byTopic.set(key, s);
  }

  type Row = { subject: string; topic: string; count: number; pct: number; awarded: number; available: number };
  const rows: Row[] = [];
  for (const s of byTopic.values()) {
    if (s.available === 0) continue;
    if (s.count < 3) continue; // ignore small samples
    rows.push({
      subject: s.subject,
      topic: s.topic,
      count: s.count,
      pct: (s.awarded / s.available) * 100,
      awarded: s.awarded,
      available: s.available,
    });
  }
  rows.sort((a, b) => a.pct - b.pct);

  console.log(`Weakest topics (≥3 questions; sorted by % score, ascending):\n`);
  console.log("subject     topic                                                pct%   awarded/avail   qs");
  console.log("-".repeat(110));
  for (const r of rows.slice(0, 20)) {
    console.log(
      r.subject.padEnd(11),
      r.topic.padEnd(50),
      r.pct.toFixed(1).padStart(5),
      `   ${r.awarded.toString().padStart(5)} / ${r.available.toString().padStart(5)}`,
      `  ${r.count.toString().padStart(3)}`,
    );
  }

  console.log(`\nStrongest topics (for context):\n`);
  for (const r of rows.slice(-5).reverse()) {
    console.log(
      r.subject.padEnd(11),
      r.topic.padEnd(50),
      r.pct.toFixed(1).padStart(5),
      `   ${r.awarded.toString().padStart(5)} / ${r.available.toString().padStart(5)}`,
      `  ${r.count.toString().padStart(3)}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
