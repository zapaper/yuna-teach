// One-off backfill: Red Swastika 2025 P6 Science Booklet A Q1-Q12 came
// in with null marksAvailable because the structure analyser split
// Booklet A and the first sub-section landed without an MCQ label.
// The answer keys for Q1-Q12 are all "(1)"-"(4)" so they're
// unambiguously MCQ — set marksAvailable to 2 (PSLE Science MCQ
// convention).

import { prisma } from "../src/lib/db";

const PAPER_ID = "cmptq7cua00bnzgzx1093rbt2";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true },
  });
  if (!paper) { console.log("paper not found"); return; }
  if (!(paper.subject ?? "").toLowerCase().includes("science")) {
    console.log(`paper subject is "${paper.subject}" — refusing backfill (Science only)`);
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

  console.log(`\nFound ${toUpdate.length} null-mark Qs with MCQ-shape answers: ${toUpdate.map(q => `Q${q.questionNum}`).join(", ")}`);
  if (toUpdate.length === 0) { console.log("nothing to do"); return; }

  await prisma.$transaction(
    toUpdate.map(q => prisma.examQuestion.update({
      where: { id: q.id },
      data: { marksAvailable: 2 },
    }))
  );
  console.log(`\nUpdated ${toUpdate.length} questions to marksAvailable=2.`);

  // Verify
  const after = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, questionNum: { in: toUpdate.map(q => q.questionNum) } },
    select: { questionNum: true, marksAvailable: true },
    orderBy: { orderIndex: "asc" },
  });
  console.log("Verification:");
  for (const q of after) {
    console.log(`  Q${q.questionNum}: marksAvailable=${q.marksAvailable}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
