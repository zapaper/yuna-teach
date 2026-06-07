// Probe what gpt-5 actually stored for the failed OEQs — is
// studentAnswer null (Phase 1 vision failure) or populated but with
// the marker awarding 0 for other reasons?

import { prisma } from "../src/lib/db";

const CLONE_PREFIX = "cmpugyxqd"; // Respiratory clone from gpt-5 run

async function main() {
  const p = await prisma.examPaper.findFirst({
    where: { id: { startsWith: CLONE_PREFIX } },
    select: { id: true, title: true },
  });
  if (!p) { console.log("clone not found — was it cleaned up?"); return; }
  console.log(`probing ${p.title} (${p.id})`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: p.id },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, marksAvailable: true, marksAwarded: true,
      markingNotes: true, studentAnswer: true, answer: true,
    },
  });
  for (const q of qs) {
    const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    if (/^[1-4]$/.test(ansNorm) || /^[A-D]$/i.test(ansNorm)) continue;
    console.log(`\n--- Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}m`);
    console.log(`  student detected: ${q.studentAnswer === null ? "(null)" : JSON.stringify(q.studentAnswer.slice(0, 200))}`);
    console.log(`  notes (first 300): ${(q.markingNotes ?? "(null)").slice(0, 300)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
