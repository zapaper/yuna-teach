import { prisma } from "../src/lib/db";

const CIRCUIT_PAPER_IDS_QUERY = {
  sourceExamId: null,
  NOT: { title: { startsWith: "Test Quiz" } },
  AND: [
    { title: { contains: "PSLE", mode: "insensitive" as const } },
    { title: { contains: "science", mode: "insensitive" as const } },
  ],
};

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: CIRCUIT_PAPER_IDS_QUERY,
    select: { id: true, title: true },
  });
  console.log("Papers in scope:", papers.map(p => p.title).join(", "));

  let totalQs = 0;
  let totalMarks = 0;
  let circuitQs = 0;
  let circuitMarks = 0;
  let circuitMcq = 0;
  let circuitOeq = 0;

  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { id: true, syllabusTopic: true, marksAvailable: true, transcribedOptions: true },
    });
    let pCircuitQs = 0, pCircuitMarks = 0, pCircuitMcq = 0, pCircuitOeq = 0;
    let pTotalQs = 0, pTotalMarks = 0;
    for (const q of qs) {
      pTotalQs++;
      pTotalMarks += q.marksAvailable ?? 0;
      const topic = (q.syllabusTopic ?? "").toLowerCase();
      const isCircuit = topic.includes("electric") || topic.includes("circuit") || topic.includes("magnet");
      if (isCircuit) {
        pCircuitQs++;
        pCircuitMarks += q.marksAvailable ?? 0;
        const hasOptions = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4;
        if (hasOptions) pCircuitMcq++;
        else pCircuitOeq++;
      }
    }
    console.log(`  ${p.title}: ${pTotalQs} qs (${pTotalMarks}m total), circuit ${pCircuitQs} qs (${pCircuitMcq} MCQ + ${pCircuitOeq} OEQ, ${pCircuitMarks}m)`);
    totalQs += pTotalQs;
    totalMarks += pTotalMarks;
    circuitQs += pCircuitQs;
    circuitMarks += pCircuitMarks;
    circuitMcq += pCircuitMcq;
    circuitOeq += pCircuitOeq;
  }

  console.log(`\n--- 2020-2024 totals ---`);
  console.log(`Total questions: ${totalQs}`);
  console.log(`Total marks: ${totalMarks}`);
  console.log(`Circuit questions: ${circuitQs}  (${circuitMcq} MCQ + ${circuitOeq} OEQ)`);
  console.log(`Circuit marks: ${circuitMarks}`);
  console.log(`Circuit % of total marks: ${totalMarks ? ((circuitMarks / totalMarks) * 100).toFixed(1) : "?"}%`);
  console.log(`Circuit % of total questions: ${totalQs ? ((circuitQs / totalQs) * 100).toFixed(1) : "?"}%`);

  await prisma.$disconnect();
})();
