// PSLE Science topic frequency for 2022-2024 only, using the four
// comprehensive papers in the DB. Percentages computed against the
// TOTAL PSLE Science marks (sum across all 4 papers), not within a
// life/physical sub-bucket.
import { prisma } from "../src/lib/db";

(async () => {
  const titles = [
    "PSLE Physical Science MCQ 2022-2024",
    "PSLE Physical science OEQ 2022-2024",
    "PSLE Life Science OEQ 2022-2024",
    "P6 Life Science MCQ 2022-2024",
  ];
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, title: { in: titles } },
    select: { id: true, title: true },
  });
  type Row = { qs: number; mcq: number; oeq: number; marks: number };
  const byTopic = new Map<string, Row>();
  let totalQs = 0, totalMarks = 0;
  for (const p of papers) {
    const isMcqPaper = p.title.toLowerCase().includes("mcq");
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { syllabusTopic: true, marksAvailable: true },
    });
    for (const q of qs) {
      totalQs++;
      totalMarks += q.marksAvailable ?? 0;
      const topic = (q.syllabusTopic ?? "(no topic)").trim();
      const row = byTopic.get(topic) ?? { qs: 0, mcq: 0, oeq: 0, marks: 0 };
      row.qs++;
      if (isMcqPaper) row.mcq++; else row.oeq++;
      row.marks += q.marksAvailable ?? 0;
      byTopic.set(topic, row);
    }
  }
  const sorted = [...byTopic.entries()].sort((a, b) => b[1].marks - a[1].marks);
  console.log(`Total: ${totalQs} qs / ${totalMarks} marks across ${papers.length} papers (3 years: 2022-2024)`);
  console.log();
  console.log(
    "Topic".padEnd(60) + " | Qs    MCQ  OEQ  Marks  % of total marks"
  );
  console.log("-".repeat(110));
  for (const [t, r] of sorted) {
    const pct = totalMarks ? ((r.marks / totalMarks) * 100).toFixed(1) : "—";
    console.log(
      t.padEnd(60).slice(0, 60) + " | " +
      String(r.qs).padStart(3) + "   " +
      String(r.mcq).padStart(3) + "  " +
      String(r.oeq).padStart(3) + "  " +
      String(r.marks).padStart(4) + "   " +
      pct.padStart(5) + "%"
    );
  }
  await prisma.$disconnect();
})();
