import { prisma } from "../src/lib/db";

// Find PSLE Science MCQs whose options are stored as a table
// (transcribedOptionTable: { columns, rows }). These render as a
// data grid in the quiz UI — heavy ones (many columns) can be tight
// on a phone screen.

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "science", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: { id: true, year: true, title: true },
    orderBy: { year: "asc" },
  });

  type Hit = {
    paperId: string; paperTitle: string; year: string | null;
    qId: string; qNum: string; cols: number; rows: number;
    columnsList: string[]; sampleRow: string;
    syllabusTopic: string | null;
  };
  const hits: Hit[] = [];

  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, transcribedOptionTable: { not: undefined } },
      select: { id: true, questionNum: true, transcribedOptionTable: true, syllabusTopic: true },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      const t = q.transcribedOptionTable as { columns?: string[]; rows?: string[][] } | null;
      if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) continue;
      hits.push({
        paperId: p.id, paperTitle: p.title, year: p.year,
        qId: q.id, qNum: q.questionNum,
        cols: t.columns.length, rows: t.rows.length,
        columnsList: t.columns,
        sampleRow: (t.rows[0] ?? []).join(" | "),
        syllabusTopic: q.syllabusTopic,
      });
    }
  }
  console.log(`Table-format MCQs in PSLE Science: ${hits.length}\n`);
  for (const h of hits) {
    console.log(`[${h.year}] Q${h.qNum.padEnd(4)} ${h.rows}×${h.cols} cols=[${h.columnsList.join(", ")}]`);
    console.log(`           row1: ${h.sampleRow}`);
    if (h.syllabusTopic) console.log(`           topic: ${h.syllabusTopic}`);
  }

  // Heuristic: "heavy" = 4 or more columns (3+ data columns + the option label)
  const heavy = hits.filter(h => h.cols >= 4);
  console.log(`\nHeavy (≥4 cols): ${heavy.length}`);
  for (const h of heavy) {
    console.log(`  ${h.qId}  [${h.year}] Q${h.qNum} ${h.rows}×${h.cols}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
