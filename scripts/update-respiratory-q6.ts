// Update P6 Focused: Human Respiratory Q6 marksAwarded to 3 (was 2.5).
// User-set canonical: student missed key vocabulary "nose" and "lungs" in
// part (c) — should deduct from 4 down to 3.
import { prisma } from "../src/lib/db";

const PAPER_ID = "cmoqkmwxa000pwu99qiiwf74x";
const TARGET = 3;
const apply = process.argv.includes("--apply");

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: "6" },
    select: { id: true, marksAvailable: true, marksAwarded: true },
  });
  if (!q) { console.log("Question not found"); return; }

  console.log(`Q6 current: marksAwarded=${q.marksAwarded} (available=${q.marksAvailable})`);
  console.log(`Planned: marksAwarded=${TARGET}`);

  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, score: true },
  });
  const delta = (q.marksAwarded ?? 0) - TARGET;
  const newScore = (paper?.score ?? 0) - delta;
  console.log(`Paper score: ${paper?.score} → ${newScore}`);

  if (!apply) { console.log("\nDRY RUN. Re-run with --apply."); return; }

  await prisma.$transaction([
    prisma.examQuestion.update({ where: { id: q.id }, data: { marksAwarded: TARGET } }),
    prisma.examPaper.update({ where: { id: PAPER_ID }, data: { score: newScore } }),
  ]);
  console.log("✅ Updated.");
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
