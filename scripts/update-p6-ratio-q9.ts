// One-off: update P6 Focused: Ratio Q9 marksAwarded from 2 → 1 to match
// the eval baseline. The marker keeps re-awarding 2 (partial credit too
// generous), but the user-set canonical is 1 mark.
import { prisma } from "../src/lib/db";

const PAPER_ID = "cmotr5qoz000ih6io0b4z2erx";
const apply = process.argv.includes("--apply");

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: "9" },
    select: { id: true, marksAvailable: true, marksAwarded: true },
  });
  if (!q) { console.log("Question not found"); return; }

  console.log(`Q9 current: marksAwarded=${q.marksAwarded} (available=${q.marksAvailable})`);
  console.log(`Planned: marksAwarded=1`);

  // Recompute paper score: subtract delta from current.
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, score: true },
  });
  const delta = (q.marksAwarded ?? 0) - 1;
  const newScore = (paper?.score ?? 0) - delta;
  console.log(`Paper score: ${paper?.score} → ${newScore}`);

  if (!apply) { console.log("\nDRY RUN. Re-run with --apply."); return; }

  await prisma.$transaction([
    prisma.examQuestion.update({ where: { id: q.id }, data: { marksAwarded: 1 } }),
    prisma.examPaper.update({ where: { id: PAPER_ID }, data: { score: newScore } }),
  ]);
  console.log("✅ Updated.");
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
