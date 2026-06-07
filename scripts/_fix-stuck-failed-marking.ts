// Repair markingStatus on papers that were fully marked but had their
// outer try/catch clobber the status back to "failed" (usually because
// generateFeedbackSummary threw on a Gemini 429 right after the main
// marking transaction had already committed marks + score).
//
// Usage: npx tsx scripts/_fix-stuck-failed-marking.ts <paperId>

import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2];

async function main() {
  if (!PAPER_ID) { console.log("usage: <paperId>"); return; }
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, score: true, markingStatus: true },
  });
  if (!p) { console.log("paper not found"); return; }
  console.log(`paper: ${p.title}`);
  console.log(`  current: status=${p.markingStatus}  score=${p.score}`);

  if (p.markingStatus !== "failed") {
    console.log(`status is "${p.markingStatus}", not "failed" — refusing`);
    return;
  }
  // Sanity check: all questions must be marked + sum match paper.score.
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { marksAwarded: true },
  });
  const nullCount = qs.filter(q => q.marksAwarded == null).length;
  const sum = qs.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  if (nullCount > 0) {
    console.log(`refusing — ${nullCount} questions still unmarked`);
    return;
  }
  if (Math.abs(sum - (p.score ?? -1)) > 0.001) {
    console.log(`refusing — sum of marksAwarded (${sum}) doesn't match paper.score (${p.score})`);
    return;
  }
  await prisma.examPaper.update({
    where: { id: PAPER_ID },
    data: { markingStatus: "complete" },
  });
  console.log(`✓ status flipped to "complete"`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
