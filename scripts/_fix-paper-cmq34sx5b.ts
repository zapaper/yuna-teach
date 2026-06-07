import { prisma } from "../src/lib/db";
const PAPER = "cmq34sx5b004qgnicjxy3flh6";
async function main() {
  // Q6 source: Q38c subpart text says [1marks] but marksAvailable=2.
  // The actual question (c) part is 1 mark — fix the clone to match.
  // Student answered correctly → 1/1.
  await prisma.examQuestion.update({
    where: { id: "cmq34sx5e004wgnic7yy1sdip" },
    data: { marksAvailable: 1 },
  });
  // Recompute paper-level totals from current state.
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    select: { questionNum: true, marksAvailable: true, marksAwarded: true },
    orderBy: { orderIndex: "asc" },
  });
  const score = qs.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const total = qs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  await prisma.examPaper.update({
    where: { id: PAPER },
    data: { score, totalMarks: String(total) },
  });
  console.log(`Updated paper ${PAPER}: score=${score}, totalMarks=${total}`);
  console.log("Per-question:");
  for (const q of qs) console.log(`  Q${q.questionNum}: ${q.marksAwarded ?? 0}/${q.marksAvailable ?? 0}`);
  process.exit(0);
}
main();
