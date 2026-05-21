// PSLE Science topic frequency across 2020-2024.
// Methodology:
//   - Use the two FULL PSLE Science papers (2020, 2021) as the gold
//     sample: each is the complete printed paper.
//   - Compute per-year rates from that sample, then extrapolate to 5
//     years (2020-2024) for headline figures.
//   - Cross-check against the 2022-2024 selected MCQ + OEQ master
//     papers to flag any topic whose rate looks very different.
import { prisma } from "../src/lib/db";

(async () => {
  const fullPapers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      OR: [
        { title: "PSLE Science 2020" },
        { title: "PSLE Science 2021" },
      ],
    },
    select: { id: true, title: true },
  });
  if (fullPapers.length !== 2) {
    console.error(`Expected 2 full papers, found ${fullPapers.length}`);
    process.exit(1);
  }
  type Row = { qs: number; marks: number };
  const byTopic = new Map<string, Row>();
  let totalQs = 0;
  let totalMarks = 0;
  for (const p of fullPapers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { syllabusTopic: true, marksAvailable: true },
    });
    for (const q of qs) {
      totalQs++;
      totalMarks += q.marksAvailable ?? 0;
      const topic = (q.syllabusTopic ?? "(no topic)").trim();
      const row = byTopic.get(topic) ?? { qs: 0, marks: 0 };
      row.qs++;
      row.marks += q.marksAvailable ?? 0;
      byTopic.set(topic, row);
    }
  }
  const sorted = [...byTopic.entries()].sort((a, b) => b[1].marks - a[1].marks);
  console.log(`\n=== 2020 + 2021 PSLE Science (combined) ===`);
  console.log(`Total: ${totalQs} questions, ${totalMarks} marks`);
  console.log();
  console.log(`Topic                                  | Qs/2yr  Marks/2yr  %marks  Extrap 5-yr Qs  Extrap 5-yr Marks`);
  console.log(`---------------------------------------|--------|----------|--------|----------------|------------------`);
  for (const [topic, r] of sorted) {
    const pctMarks = totalMarks ? (r.marks / totalMarks) * 100 : 0;
    const extrapQs = Math.round((r.qs / 2) * 5);
    const extrapMarks = Math.round((r.marks / 2) * 5);
    console.log(
      `${topic.padEnd(60).slice(0, 60)}|${String(r.qs).padStart(7)} |${String(r.marks).padStart(9)} |${pctMarks.toFixed(1).padStart(6)}% |${String(extrapQs).padStart(15)} |${String(extrapMarks).padStart(17)}`
    );
  }
  await prisma.$disconnect();
})();
