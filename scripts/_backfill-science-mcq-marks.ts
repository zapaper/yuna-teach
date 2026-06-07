// Reusable backfill: for a given Science paper, set marksAvailable=2 on
// any null-mark question whose answer shape is MCQ ("(1)"-"(4)" or
// "(A)"-"(D)"). Safe to re-run.
//
// Usage: npx tsx scripts/_backfill-science-mcq-marks.ts <paperId>

import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2];

async function main() {
  if (!PAPER_ID) { console.log("usage: <paperId>"); return; }
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true },
  });
  if (!paper) { console.log("paper not found"); return; }
  if (!(paper.subject ?? "").toLowerCase().includes("science")) {
    console.log(`subject="${paper.subject}" — refusing (Science only)`);
    return;
  }
  console.log(`paper: ${paper.title}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, marksAvailable: null },
    select: { id: true, questionNum: true, answer: true },
  });
  const toUpdate = qs.filter(q => {
    const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim().toUpperCase();
    return /^[1-4]$/.test(ansNorm) || /^[A-D]$/.test(ansNorm);
  });
  console.log(`\nFound ${toUpdate.length} null-mark MCQ-shaped Qs: ${toUpdate.map(q => `Q${q.questionNum}`).join(", ")}`);
  if (toUpdate.length === 0) { console.log("nothing to do"); return; }

  await prisma.$transaction(
    toUpdate.map(q => prisma.examQuestion.update({
      where: { id: q.id }, data: { marksAvailable: 2 },
    }))
  );
  console.log(`\nUpdated ${toUpdate.length} questions to marksAvailable=2.`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
