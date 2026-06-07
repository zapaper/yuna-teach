// Heuristic year split for the 2022-2024 master papers, focused on
// "Interactions within the environment" to see whether one year drives
// the topic share. PSLE Science MCQ has 14 Qs/year, so we split each
// MCQ paper as Q1-14 / Q15-28 / Q29-42. For OEQ papers we split the
// question list into 3 equal-sized chunks in original order.
import { prisma } from "../src/lib/db";

type Row = { qs: number; marks: number };

function yearForMcq(qNum: string): "2022" | "2023" | "2024" | "?" {
  const n = parseInt(qNum.match(/\d+/)?.[0] ?? "0", 10);
  if (!n) return "?";
  if (n <= 14) return "2022";
  if (n <= 28) return "2023";
  if (n <= 42) return "2024";
  return "?";
}

function yearForOeqByOrder(idx: number, total: number): "2022" | "2023" | "2024" {
  const third = total / 3;
  if (idx < third) return "2022";
  if (idx < 2 * third) return "2023";
  return "2024";
}

(async () => {
  const titles = [
    { t: "P6 Life Science MCQ 2022-2024", kind: "mcq" as const },
    { t: "PSLE Physical Science MCQ 2022-2024", kind: "mcq" as const },
    { t: "PSLE Life Science OEQ 2022-2024", kind: "oeq" as const },
    { t: "PSLE Physical science OEQ 2022-2024", kind: "oeq" as const },
  ];

  // Year → topic → row
  const interactions: Record<string, Row> = { "2022": { qs: 0, marks: 0 }, "2023": { qs: 0, marks: 0 }, "2024": { qs: 0, marks: 0 } };
  const totals: Record<string, Row> = { "2022": { qs: 0, marks: 0 }, "2023": { qs: 0, marks: 0 }, "2024": { qs: 0, marks: 0 } };

  for (const { t, kind } of titles) {
    const paper = await prisma.examPaper.findFirst({
      where: { sourceExamId: null, title: t },
      select: { id: true },
    });
    if (!paper) continue;
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id },
      select: { questionNum: true, syllabusTopic: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    });
    qs.forEach((q, i) => {
      const year = kind === "mcq" ? yearForMcq(q.questionNum) : yearForOeqByOrder(i, qs.length);
      if (year === "?") return;
      totals[year].qs += 1;
      totals[year].marks += q.marksAvailable ?? 0;
      const topic = (q.syllabusTopic ?? "").toLowerCase();
      if (topic.includes("interactions") && topic.includes("environment")) {
        interactions[year].qs += 1;
        interactions[year].marks += q.marksAvailable ?? 0;
      }
    });
  }

  console.log(`\nInteractions within environment — by inferred year:\n`);
  console.log(`Year | Interactions Qs | Interactions Marks | Total Marks | % of total marks`);
  console.log(`-----|-----------------|--------------------|-------------|----------------`);
  for (const y of ["2022", "2023", "2024"]) {
    const ix = interactions[y];
    const tot = totals[y];
    const pct = tot.marks ? ((ix.marks / tot.marks) * 100).toFixed(1) : "—";
    console.log(`${y} | ${String(ix.qs).padStart(15)} | ${String(ix.marks).padStart(18)} | ${String(tot.marks).padStart(11)} | ${pct.padStart(13)}%`);
  }
  console.log();
  console.log(`Split assumption: MCQ Q1-14 = 2022, Q15-28 = 2023, Q29-42 = 2024.`);
  console.log(`OEQ split by orderIndex into 3 equal-sized chunks (no year tag in DB).`);

  await prisma.$disconnect();
})();
