// Dump every "Visual Text Comprehension MCQ" question that getWeakTopics()
// is counting for Mark Lim. We want to see if 104 is real or inflated by
// duplicates / mis-tagging.

import { prisma } from "../src/lib/db";

async function main() {
  const u = await prisma.user.findFirst({
    where: { name: { contains: "mark lim", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, name: true },
  });
  if (!u) { console.log("No student"); return; }
  console.log(`Student: ${u.name}\n`);

  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: u.id, markingStatus: { in: ["complete", "released"] } },
    select: {
      id: true, title: true, subject: true, paperType: true, completedAt: true,
      metadata: true,
      questions: {
        where: { syllabusTopic: "Visual Text Comprehension MCQ" },
        select: { id: true, questionNum: true, transcribedStem: true, marksAwarded: true, marksAvailable: true, sourceQuestionId: true },
      },
    },
    orderBy: { completedAt: "asc" },
  });

  let total = 0;
  const seenStems = new Map<string, number>();
  for (const p of papers) {
    if (p.questions.length === 0) continue;
    const meta = p.metadata as { revisionMode?: string } | null;
    const skip = meta?.revisionMode ? " [SKIPPED — revisionMode]" : "";
    console.log(`[${(p.paperType ?? "master").padEnd(15)}] ${String(p.questions.length).padStart(3)}q  ${(p.title ?? "").slice(0, 60)}${skip}`);
    if (!meta?.revisionMode) total += p.questions.length;
    for (const q of p.questions) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      seenStems.set(stem, (seenStems.get(stem) ?? 0) + 1);
    }
  }
  console.log(`\nTotal counted toward weak topics (excluding revisionMode): ${total}`);

  console.log(`\nUnique stems: ${seenStems.size}  (total instances: ${[...seenStems.values()].reduce((a, b) => a + b, 0)})`);
  console.log(`\nMost-repeated stems (top 10):`);
  for (const [stem, n] of [...seenStems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ×${n}  ${stem}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
