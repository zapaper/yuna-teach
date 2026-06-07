// Confirm whether mastery quizzes feed into the weak-topics percentage
// for Mark Lim, specifically the Chinese sentence-completion run.

import { prisma } from "../src/lib/db";
import { getWeakTopics } from "../src/lib/weak-topics";

async function main() {
  const u = await prisma.user.findFirst({
    where: { name: { contains: "mark lim", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, name: true },
  });
  if (!u) { console.log("No student"); return; }
  console.log(`Student: ${u.name} (${u.id})\n`);

  console.log("=== Every marked paper, with paperType ===");
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: u.id, markingStatus: { in: ["complete", "released"] } },
    select: {
      id: true, title: true, subject: true, paperType: true,
      completedAt: true, metadata: true, markingStatus: true,
      questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true } },
    },
    orderBy: { completedAt: "asc" },
  });

  let totalQ = 0, masteryQ = 0;
  for (const p of papers) {
    const meta = p.metadata as { revisionMode?: string } | null;
    const isRevision = !!meta?.revisionMode;
    const qCount = p.questions.length;
    totalQ += qCount;
    if (p.paperType === "mastery") masteryQ += qCount;
    const flag = isRevision ? " [SKIPPED — revisionMode]" : "";
    console.log(`  [${(p.paperType ?? "master").padEnd(15)}] ${qCount.toString().padStart(3)}q  ${p.subject?.padEnd(8)}  ${p.title?.slice(0, 60)}${flag}`);
  }
  console.log(`\nTotal: ${papers.length} papers · ${totalQ} questions  (mastery contributes ${masteryQ})`);

  console.log("\n=== Per-bucket roll-up that getWeakTopics() builds ===");
  type Bucket = { subject: string; topic: string; awarded: number; available: number; n: number; mastery: number };
  const buckets = new Map<string, Bucket>();
  function bucketSubject(raw: string | null | undefined): "Math" | "Science" | "English" | "Chinese" | "Other" {
    const lower = (raw ?? "").toLowerCase();
    if (lower.includes("math")) return "Math";
    if (lower.includes("science") || lower.includes("sci")) return "Science";
    if (lower.includes("english") || lower.includes("eng")) return "English";
    if (lower.includes("chinese") || lower.includes("华文")) return "Chinese";
    return "Other";
  }
  for (const p of papers) {
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
      const b = buckets.get(key) ?? { subject, topic, awarded: 0, available: 0, n: 0, mastery: 0 };
      b.awarded += awarded;
      b.available += avail;
      b.n++;
      if (p.paperType === "mastery") b.mastery++;
      buckets.set(key, b);
    }
  }
  const rows = [...buckets.values()]
    .filter(b => b.n >= 5)
    .sort((a, b) => a.awarded / a.available - b.awarded / b.available);
  console.log("\nTopic                                         Subject   N  Mastery  Pct");
  console.log("-".repeat(90));
  for (const r of rows) {
    const pct = (r.awarded / r.available) * 100;
    console.log(
      r.topic.slice(0, 44).padEnd(46),
      r.subject.padEnd(8),
      String(r.n).padStart(3),
      String(r.mastery).padStart(7),
      `${pct.toFixed(1)}%`.padStart(6),
    );
  }

  console.log("\n=== What the AI Smart Insights card actually shows (top 5 weak) ===");
  const top = await getWeakTopics(u.id, 5);
  for (const r of top) console.log(`  ${r.subject.padEnd(8)} ${r.topic.padEnd(40)} ${r.pct.toFixed(1)}%  N=${r.sample}  improving=${r.improving}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
