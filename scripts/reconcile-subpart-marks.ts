// Re-parse markingNotes for the given paper and upgrade marksAwarded
// when per-part "Awarded N mark(s)" lines sum to MORE than the stored
// total. Targets the bug where AI returned marksAwarded=0 at top but
// awarded e.g. 1 mark to part (b) in the notes — fixed forward, but
// existing marked papers need this one-shot backfill.

import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!PAPER_ID) { console.error("Usage: tsx reconcile-subpart-marks.ts <paperId> [--apply]"); process.exit(1); }
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, score: true },
  });
  if (!paper) { console.error("Paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title} (score before: ${paper.score})`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true, markingNotes: true },
    orderBy: { orderIndex: "asc" },
  });

  let totalDelta = 0;
  const updates: Array<{ id: string; qNum: string; from: number | null; to: number }> = [];
  for (const q of qs) {
    if (!q.markingNotes) continue;
    const notes = q.markingNotes;
    // Chunk by "Part (x):" / "(x):" headers. Match the upgrade logic
    // in src/lib/marking.ts so the backfill matches forward behaviour.
    const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(?([a-z](?:-[i]+)?)\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z](?:-[i]+)?\)\s*:?|$)/gi;
    let chunkSum = 0;
    let chunkCount = 0;
    for (const m of notes.matchAll(partRe)) {
      const chunk = m[2];
      const awardMatches = [...chunk.matchAll(/awarded\s+(\d+(?:\.\d+)?)\s*marks?\b/gi)];
      if (awardMatches.length === 0) continue;
      const partAwarded = parseFloat(awardMatches[awardMatches.length - 1][1]);
      chunkSum += partAwarded;
      chunkCount++;
    }
    if (chunkCount < 1) continue;
    const cap = q.marksAvailable ?? chunkSum;
    const newTotal = Math.min(cap, chunkSum);
    const cur = q.marksAwarded ?? 0;
    if (newTotal > cur) {
      console.log(`  Q${q.questionNum.padEnd(6)} chunks=${chunkCount} sum=${chunkSum} → ${newTotal} (was ${cur})`);
      updates.push({ id: q.id, qNum: q.questionNum, from: q.marksAwarded, to: newTotal });
      totalDelta += newTotal - cur;
    }
  }

  if (updates.length === 0) {
    console.log("Nothing to upgrade.");
    return;
  }
  console.log(`\n${APPLY ? "Applying" : "Would apply"} ${updates.length} upgrades, total +${totalDelta} marks.`);
  if (!APPLY) {
    console.log("Pass --apply to write.");
    return;
  }
  for (const u of updates) {
    await prisma.examQuestion.update({ where: { id: u.id }, data: { marksAwarded: u.to } });
  }
  // Recompute paper score = sum of marksAwarded.
  const fresh = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { marksAwarded: true },
  });
  const newScore = fresh.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  await prisma.examPaper.update({ where: { id: PAPER_ID }, data: { score: newScore } });
  console.log(`Paper score: ${paper.score} → ${newScore}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
